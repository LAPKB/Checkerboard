use crate::{auth::CapturedAuthorization, error::AppError};
use serde::{Serialize, Serializer, ser::Error as _};
use std::sync::Arc;

const REDACTED_SERIALIZATION_ERROR: &str = "Protected output unavailable";

struct OutputGuard {
    authorization: Option<CapturedAuthorization>,
    denied: bool,
}

pub(crate) struct ProtectedOutput<T> {
    guard: Arc<OutputGuard>,
    value: T,
    #[cfg(test)]
    permit_checker: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl<T: Clone> Clone for ProtectedOutput<T> {
    fn clone(&self) -> Self {
        Self {
            guard: Arc::clone(&self.guard),
            value: self.value.clone(),
            #[cfg(test)]
            permit_checker: self.permit_checker.as_ref().map(Arc::clone),
        }
    }
}

pub(crate) type ProtectedResult<T, E = AppError> = Result<ProtectedOutput<T>, ProtectedOutput<E>>;

impl<T> ProtectedOutput<T> {
    pub(crate) fn new(authorization: CapturedAuthorization, value: T) -> Self {
        Self {
            guard: Arc::new(OutputGuard {
                authorization: Some(authorization),
                denied: false,
            }),
            value,
            #[cfg(test)]
            permit_checker: None,
        }
    }

    fn denied(authorization: CapturedAuthorization, value: T) -> Self {
        Self {
            guard: Arc::new(OutputGuard {
                authorization: Some(authorization),
                denied: true,
            }),
            value,
            #[cfg(test)]
            permit_checker: None,
        }
    }

    #[cfg(test)]
    fn new_with_checker(value: T, checker: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            guard: Arc::new(OutputGuard {
                authorization: None,
                denied: false,
            }),
            value,
            permit_checker: Some(Arc::new(checker)),
        }
    }

    fn permit_is_valid(&self) -> bool {
        #[cfg(test)]
        if let Some(checker) = self.permit_checker.as_ref() {
            return checker();
        }

        !self.guard.denied
            && self
                .guard
                .authorization
                .as_ref()
                .is_some_and(CapturedAuthorization::is_valid)
    }
}

pub(crate) fn send<T: Serialize>(
    authorization: &CapturedAuthorization,
    channel: &tauri::ipc::Channel<ProtectedOutput<T>>,
    value: T,
) -> tauri::Result<()> {
    channel.send(ProtectedOutput::new(authorization.clone(), value))
}

pub(crate) fn denied(authorization: &CapturedAuthorization) -> ProtectedOutput<AppError> {
    ProtectedOutput::denied(
        authorization.clone(),
        AppError::new(
            "accessDenied",
            authorization.auth().denial_message().to_string(),
        ),
    )
}

impl<T> std::fmt::Debug for ProtectedOutput<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedOutput")
            .finish_non_exhaustive()
    }
}

impl<T: Serialize> Serialize for ProtectedOutput<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if !self.permit_is_valid() {
            return Err(S::Error::custom(REDACTED_SERIALIZATION_ERROR));
        }
        let result = self.value.serialize(serializer);
        if !self.permit_is_valid() {
            return Err(S::Error::custom(REDACTED_SERIALIZATION_ERROR));
        }
        result
    }
}

pub(crate) fn protect_result<T>(
    authorization: CapturedAuthorization,
    result: Result<T, AppError>,
) -> ProtectedResult<T> {
    if !authorization.is_valid() {
        return Err(denied(&authorization));
    }
    match result {
        Ok(value) => Ok(ProtectedOutput::new(authorization, value)),
        Err(error) => Err(ProtectedOutput::new(authorization, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    struct RevokeDuringSerialize(Arc<AtomicBool>);

    impl Serialize for RevokeDuringSerialize {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            self.0.store(false, Ordering::SeqCst);
            serializer.serialize_str("secret payload")
        }
    }

    #[test]
    fn output_checks_authority_before_and_after_serialization() {
        let valid = Arc::new(AtomicBool::new(true));
        let output =
            ProtectedOutput::new_with_checker(RevokeDuringSerialize(Arc::clone(&valid)), {
                let valid = Arc::clone(&valid);
                move || valid.load(Ordering::SeqCst)
            });
        let error = serde_json::to_string(&output).expect_err("revoked output must fail");
        assert_eq!(error.to_string(), REDACTED_SERIALIZATION_ERROR);
    }

    #[test]
    fn revoked_output_is_rejected_before_private_values_are_serialized() {
        let checks = Arc::new(AtomicUsize::new(0));
        let output = ProtectedOutput::new_with_checker(json!({"private": "value"}), {
            let checks = Arc::clone(&checks);
            move || {
                checks.fetch_add(1, Ordering::SeqCst);
                false
            }
        });
        assert!(serde_json::to_string(&output).is_err());
        assert_eq!(checks.load(Ordering::SeqCst), 1);
    }
}
