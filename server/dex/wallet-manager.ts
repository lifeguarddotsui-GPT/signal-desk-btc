import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import nacl from "tweetnacl";

const WALLET_ENCRYPTION_KEY = process.env.SESSION_SECRET || "blue-water-agents-default-key";

function deriveKey(secret: string): Uint8Array {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = data[i % data.length] ^ (i * 37);
  }
  return key;
}

export function generateAgentWallet(): { address: string; publicKey: string; encryptedPrivateKey: string } {
  const keypair = new Ed25519Keypair();
  const address = keypair.getPublicKey().toSuiAddress();
  const publicKey = keypair.getPublicKey().toBase64();
  const secretKeyRaw = keypair.getSecretKey();
  const secretKeyBytes = typeof secretKeyRaw === "string"
    ? new TextEncoder().encode(secretKeyRaw)
    : secretKeyRaw;

  const key = deriveKey(WALLET_ENCRYPTION_KEY);
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.secretbox(secretKeyBytes, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  const encryptedPrivateKey = Buffer.from(combined).toString("base64");

  return { address, publicKey, encryptedPrivateKey };
}

export function decryptKeypair(encryptedPrivateKey: string): Ed25519Keypair {
  const key = deriveKey(WALLET_ENCRYPTION_KEY);
  const combined = Buffer.from(encryptedPrivateKey, "base64");
  const nonce = combined.subarray(0, 24);
  const ciphertext = combined.subarray(24);

  const decrypted = nacl.secretbox.open(new Uint8Array(ciphertext), new Uint8Array(nonce), key);
  if (!decrypted) {
    throw new Error("Failed to decrypt agent wallet key");
  }

  const secretKeyStr = new TextDecoder().decode(decrypted);
  return Ed25519Keypair.fromSecretKey(secretKeyStr);
}

export function getWalletAddress(encryptedPrivateKey: string): string {
  const keypair = decryptKeypair(encryptedPrivateKey);
  return keypair.getPublicKey().toSuiAddress();
}
