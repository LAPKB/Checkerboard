import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validatePilotInputs(kid, publicKeyB64) {
  // Match the pinned protocol's validate_key_id and decode_b64 contracts.
  if (
    typeof kid !== "string" ||
    kid.length === 0 ||
    kid.length > 64 ||
    /[^A-Za-z0-9_.-]/.test(kid)
  ) {
    throw new Error(
      "LAPKB_LOCAL_SIGNING_KID must be a valid SDK key ID (1-64 ASCII letters, digits, '.', '_' or '-')",
    );
  }
  const keyError =
    "LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64 must be canonical unpadded base64url for a 32-byte public key";
  if (typeof publicKeyB64 !== "string" || publicKeyB64.length !== 43) {
    throw new Error(keyError);
  }
  const decoded = Buffer.from(publicKeyB64, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== publicKeyB64) {
    throw new Error(keyError);
  }
  return { kid, publicKeyB64 };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    validatePilotInputs(
      process.env.LAPKB_LOCAL_SIGNING_KID,
      process.env.LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64,
    );
    console.log("Public pilot verification inputs have valid shape.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
