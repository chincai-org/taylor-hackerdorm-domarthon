/**
 * The LIVE model client. See SPEC.md section 11.4.
 *
 * It implements harness/contract.ts `ModelClient` over @anthropic-ai/sdk.
 * The model id for a live run is `claude-sonnet-5` and nothing else.
 *
 * Two rules this file keeps:
 *   1. It never hands the harness an API key. The key stays in this closure and
 *      appears in no request, no response and no log line.
 *   2. It never swallows a provider failure. The SDK error is rethrown as it
 *      arrived, so bench/src/runner.ts `isInfrastructure` can still read its
 *      `status` and `code` and discard the run instead of scoring it 0.
 *
 * The budget is NOT enforced here. src/model/client.ts wraps this client and
 * throws BudgetExceededError. One enforcer, one place.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelClient, ModelRequest, ModelResponse,
} from '../../harness/contract.js';
import { environmentError } from '../core/errors.js';

/** The one live model id. SPEC.md section 11.4 pins it. */
export const LIVE_MODEL_ID = 'claude-sonnet-5';

/** A live call is capped here when the harness asks for nothing. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Models that REJECT sampling parameters with HTTP 400.
 *
 * `ModelRequest.temperature` is part of the frozen contract and harness V1 sends
 * `temperature: 0`. Sending it to one of these models fails the whole task, so
 * the field is dropped and the drop is reported through the trace, never in
 * silence. On an older model the value is forwarded unchanged.
 */
const NO_SAMPLING_PARAMS: readonly string[] = [
  'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-mythos-5',
];

export const acceptsSamplingParams = (model: string): boolean =>
  !NO_SAMPLING_PARAMS.some((m) => model.startsWith(m));

export interface AnthropicClientOptions {
  /** The API key. Required. It never leaves this module. */
  readonly apiKey: string;
  /** Defaults to LIVE_MODEL_ID. */
  readonly model?: string;
  /** SDK retries for 429 and 5xx. Defaults to 2. */
  readonly maxRetries?: number;
  /** Per-request timeout in milliseconds. Defaults to 120000, the wall budget. */
  readonly timeoutMs?: number;
  /**
   * Leave thinking off by default.
   *
   * `maxTokens` in the contract means "room for the answer". With thinking on,
   * reasoning tokens eat that room and a long reply is truncated, which reads
   * like a harness defect when it is a client setting. Turn it on deliberately.
   */
  readonly thinking?: boolean;
  /** Reports a dropped or clamped request field. Optional. */
  readonly onNotice?: (kind: string, data: Record<string, unknown>) => void;
}

/** Every stop reason the provider can send, mapped onto the three the contract allows. */
function mapStopReason(raw: string | null): ModelResponse['stopReason'] {
  if (raw === 'max_tokens') return 'max_tokens';
  if (raw === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

/** The live client. One instance may serve many calls. */
export class AnthropicClient implements ModelClient {
  readonly model: string;
  private readonly sdk: Anthropic;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly thinking: boolean;
  private readonly onNotice: (kind: string, data: Record<string, unknown>) => void;

  constructor(opts: AnthropicClientOptions) {
    const apiKey = opts.apiKey.trim();
    if (apiKey.length === 0) {
      throw environmentError(
        'petri: live mode needs ANTHROPIC_API_KEY. Set it, or run with --mode replay.',
      );
    }
    this.model = opts.model ?? LIVE_MODEL_ID;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.thinking = opts.thinking ?? false;
    this.onNotice = opts.onNotice ?? ((): void => undefined);
    this.sdk = new Anthropic({
      apiKey,
      maxRetries: this.maxRetries,
      timeout: this.timeoutMs,
    });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const maxTokens = Math.max(1, Math.floor(req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      thinking: this.thinking ? { type: 'adaptive' } : { type: 'disabled' },
    };
    if (req.system !== undefined) params.system = req.system;
    if (req.stopSequences !== undefined && req.stopSequences.length > 0) {
      params.stop_sequences = [...req.stopSequences];
    }
    if (req.temperature !== undefined) {
      if (acceptsSamplingParams(this.model)) {
        params.temperature = req.temperature;
      } else {
        this.onNotice('model:dropped-field', {
          field: 'temperature', model: this.model,
          why: 'this model rejects sampling parameters with HTTP 400',
        });
      }
    }

    // Any SDK failure is rethrown untouched. Its `status` and `code` decide
    // whether the runner discards the run or scores the task 0.
    const message = await this.sdk.messages.create(params);

    let text = '';
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
    }

    // Cached input tokens are still input tokens. Never understate the cost.
    const inputTokens = message.usage.input_tokens
      + (message.usage.cache_creation_input_tokens ?? 0)
      + (message.usage.cache_read_input_tokens ?? 0);

    return {
      text,
      stopReason: mapStopReason(message.stop_reason),
      inputTokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}
