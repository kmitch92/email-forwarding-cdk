import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const TTL_MS = 5 * 60 * 1000;
const ssm = new SSMClient({});
let cache: { value: string; expiresAt: number } | undefined;

export async function getForwardTo(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const paramName = process.env.FORWARDING_SSM_PARAM;
  if (!paramName) throw new Error('FORWARDING_SSM_PARAM env var is required');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${paramName} has no value`);
  cache = { value, expiresAt: now + TTL_MS };
  return value;
}
