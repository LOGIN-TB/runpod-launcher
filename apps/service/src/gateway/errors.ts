/**
 * OpenAI-shaped error bodies.
 *
 * Clients built against OpenAI — n8n's node, the official SDKs, Open WebUI,
 * agent frameworks — read `error.message` and `error.code` out of the body.
 * A Fastify default error payload leaves them showing "Unknown error", which
 * is exactly the kind of thing that costs an hour of confused debugging.
 */
export interface OpenAiErrorBody {
  error: {
    message: string
    type: string
    param: string | null
    code: string | null
  }
}

export function openAiError(
  message: string,
  type: string,
  code: string | null = null,
): OpenAiErrorBody {
  return { error: { message, type, param: null, code } }
}

export const errors = {
  unauthorized: () =>
    openAiError(
      'Incorrect API key provided. Check the token you configured for this client.',
      'invalid_request_error',
      'invalid_api_key',
    ),

  modelNotAvailable: (requested: string, available: readonly string[]) =>
    openAiError(
      available.length === 0
        ? `No model is currently served. The pod is not running.`
        : `The model \`${requested}\` is not served by the active template. Available: ${available.join(', ')}.`,
      'invalid_request_error',
      'model_not_found',
    ),

  /** The template deliberately has this slot switched off. */
  slotDisabled: (slot: 'chat' | 'embedding') =>
    openAiError(
      `This template does not run ${slot === 'chat' ? 'a chat' : 'an embedding'} model. Enable it in the template, or point this client at a template that does.`,
      'invalid_request_error',
      'endpoint_not_available',
    ),

  stillStarting: (waitedSeconds: number) =>
    openAiError(
      `The pod is still starting after ${waitedSeconds}s. Retry shortly — loading model weights takes a few minutes.`,
      'server_error',
      'model_loading',
    ),

  noPod: () =>
    openAiError(
      'No pod exists yet. Start one from the launcher app, or pick a template with a schedule.',
      'server_error',
      'service_unavailable',
    ),

  upstream: (detail: string) =>
    openAiError(`Upstream inference server failed: ${detail}`, 'server_error', 'upstream_error'),
}
