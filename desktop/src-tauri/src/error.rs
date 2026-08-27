use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("ioError", error.to_string())
    }
}

impl From<checkerboard_core::AnalysisError> for AppError {
    fn from(error: checkerboard_core::AnalysisError) -> Self {
        Self::new("analysisError", error.to_string())
    }
}

impl From<checkerboard_core::drusano_greco::DrusanoDataError> for AppError {
    fn from(error: checkerboard_core::drusano_greco::DrusanoDataError) -> Self {
        Self::new("drusanoDataError", error.to_string())
    }
}
