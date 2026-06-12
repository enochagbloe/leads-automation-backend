import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

const VERSION = "v1";

function encryptionKey() {
  return crypto.createHash("sha256").update(env.JWT_REFRESH_SECRET).digest();
}

export function encryptCredential(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptCredential(value: string) {
  try {
    const [version, iv, authTag, encrypted] = value.split(":");
    if (version !== VERSION || !iv || !authTag || !encrypted) throw new Error("Invalid encrypted credential");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError(500, "Stored provider credential could not be decrypted", "WHATSAPP_PROVIDER_CREDENTIAL_ERROR");
  }
}
