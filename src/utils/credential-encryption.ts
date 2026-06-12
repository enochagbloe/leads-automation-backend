import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

const CURRENT_FORMAT = "v2";
const LEGACY_FORMAT = "v1";

function deriveKey(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

function currentKey() {
  if (!env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY) {
    throw new AppError(500, "WhatsApp credential encryption is not configured", "WHATSAPP_PROVIDER_CREDENTIAL_ERROR");
  }
  return deriveKey(env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY);
}

function keyring() {
  const previous = env.WHATSAPP_CREDENTIAL_DECRYPTION_KEYS
    ? JSON.parse(env.WHATSAPP_CREDENTIAL_DECRYPTION_KEYS) as Record<string, string>
    : {};
  return {
    ...previous,
    ...(env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY
      ? { [env.WHATSAPP_CREDENTIAL_KEY_ID]: env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY }
      : {}),
  };
}

export function encryptCredential(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", currentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [CURRENT_FORMAT, env.WHATSAPP_CREDENTIAL_KEY_ID, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptCredential(value: string): { plaintext: string; needsReEncryption: boolean } {
  try {
    const parts = value.split(":");
    const version = parts[0];
    const keyId = version === CURRENT_FORMAT ? parts[1] : undefined;
    const offset = version === CURRENT_FORMAT ? 2 : 1;
    const [iv, authTag, encrypted] = parts.slice(offset);
    if (!iv || !authTag || !encrypted) throw new Error("Invalid encrypted credential");
    const configuredKey = keyId ? keyring()[keyId] : undefined;
    const key = version === LEGACY_FORMAT
      ? deriveKey(env.JWT_REFRESH_SECRET)
      : configuredKey ? deriveKey(configuredKey) : undefined;
    if (!key || (version !== CURRENT_FORMAT && version !== LEGACY_FORMAT)) throw new Error("Unknown credential key");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return {
      plaintext: Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8"),
      needsReEncryption: version === LEGACY_FORMAT || keyId !== env.WHATSAPP_CREDENTIAL_KEY_ID,
    };
  } catch {
    throw new AppError(500, "Stored provider credential could not be decrypted", "WHATSAPP_PROVIDER_CREDENTIAL_ERROR");
  }
}
