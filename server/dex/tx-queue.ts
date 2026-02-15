const walletLocks = new Map<string, Promise<any>>();

export async function withWalletLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(wallet) ?? Promise.resolve();
  let release!: () => void;

  const next = new Promise<void>((res) => (release = res));
  walletLocks.set(wallet, prev.then(() => next));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (walletLocks.get(wallet) === next) walletLocks.delete(wallet);
  }
}
