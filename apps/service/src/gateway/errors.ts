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

  /**
   * The token is valid but points at nothing.
   *
   * Reached only on an installation that already had several templates when
   * targets were introduced, where binding the token to one of them would have
   * been a guess — and a wrong guess starts somebody else's GPU.
   */
  unassigned: (clientName: string) =>
    openAiError(
      `The access token "${clientName}" is not assigned to a template yet. ` +
        'Open Mappings in the launcher app and pick the pod this application should use.',
      'invalid_request_error',
      'client_unassigned',
    ),

  noPod: () =>
    openAiError(
      'No pod exists yet. Start one from the launcher app, or pick a template with a schedule.',
      'server_error',
      'service_unavailable',
    ),

  /**
   * The schedule says the model is off right now.
   *
   * Not an error in the pod: renting hardware the schedule has just released
   * would make the schedule pointless, so the request is refused with the hours
   * and a way to override them.
   */
  outsideHours: (window: string) =>
    openAiError(
      `This model runs ${window}. It is outside those hours, so nothing was started — start it from the launcher app if you need it now.`,
      'server_error',
      'outside_scheduled_hours',
    ),

  upstream: (detail: string) =>
    openAiError(`Upstream inference server failed: ${detail}`, 'server_error', 'upstream_error'),
}
