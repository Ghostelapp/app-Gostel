type Transport = (input: string) => Promise<string>;
let transport: Transport | null = null;
export function setMLSTransport(next: Transport | null) { transport = next; }
export async function invokeMLS(input: unknown): Promise<{ state: string; output: any }> {
  if (!transport) throw new Error('MLS runtime is not ready. Reopen the application.');
  const result = JSON.parse(await transport(JSON.stringify(input)));
  if (result.error || typeof result.state !== 'string') throw new Error(result.error || 'Invalid MLS runtime response');
  return result;
}
