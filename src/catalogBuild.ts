export async function buildCatalog<T>(apply: () => Promise<T>): Promise<T> {
  const [result] = await Promise.allSettled([
    apply(),
    new Promise<void>((resolve) => setTimeout(resolve, 1600)),
  ]);
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
