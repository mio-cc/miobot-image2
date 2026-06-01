type CryptoWithRandomUUID = Crypto & { randomUUID?: () => string };

function fallbackRandomUUID(): string {
  const bytes = new Uint8Array(16);
  const cryptoLike = globalThis.crypto as CryptoWithRandomUUID | undefined;

  if (cryptoLike?.getRandomValues) {
    cryptoLike.getRandomValues(bytes);
  } else {
    for (let idx = 0; idx < bytes.length; idx += 1) {
      bytes[idx] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}

const existingCrypto = globalThis.crypto as CryptoWithRandomUUID | undefined;
const cryptoLike: CryptoWithRandomUUID = existingCrypto ?? ({} as CryptoWithRandomUUID);

if (!existingCrypto) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoLike
  });
}

if (typeof cryptoLike.randomUUID !== "function") {
  Object.defineProperty(cryptoLike, "randomUUID", {
    configurable: true,
    value: fallbackRandomUUID
  });
}
