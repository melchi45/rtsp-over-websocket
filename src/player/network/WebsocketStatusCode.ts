export interface WebsocketStatus {
  value: number;
  name: string;
  description: string;
}

const STATUS_TABLE = {
  Reserved_0_999: { value: 999, name: 'Reserved', description: 'Reserved and not used.' },
  NormalClosure: {
    value: 1000,
    name: 'Normal Closure',
    description: 'Normal closure; the connection successfully completed whatever purpose for which it was created.'
  },
  GoingAway: {
    value: 1001,
    name: 'Going Away',
    description:
      'The endpoint is going away, either because of a server failure or because the browser is navigating away from the page that opened the connection.'
  },
  ProtocolError: {
    value: 1002,
    name: 'Protocol Error',
    description: 'The endpoint is terminating the connection due to a protocol error.'
  },
  UnsupportedData: {
    value: 1003,
    name: 'Unsupported Data',
    description:
      'The connection is being terminated because the endpoint received data of a type it cannot accept (for example, a text-only endpoint received binary data).'
  },
  Reserved_1004: { value: 1004, name: 'Reserved', description: 'Reserved. A meaning might be defined in the future.' },
  NoStatusRecvd: {
    value: 1005,
    name: 'No Status Recvd',
    description: 'Reserved.  Indicates that no status code was provided even though one was expected.'
  },
  AbnormalClosure: {
    value: 1006,
    name: 'Abnormal Closure',
    description:
      'Reserved. Used to indicate that a connection was closed abnormally (that is, with no close frame being sent) when a status code is expected.'
  },
  InvalidFramePayloadData: {
    value: 1007,
    name: 'Invalid frame payload data',
    description:
      'The endpoint is terminating the connection because a message was received that contained inconsistent data (e.g., non-UTF-8 data within a text message).'
  },
  PolicyViolation: {
    value: 1008,
    name: 'Policy Violation',
    description:
      'The endpoint is terminating the connection because it received a message that violates its policy. This is a generic status code, used when codes 1003 and 1009 are not suitable.'
  },
  MessageTooBig: {
    value: 1009,
    name: 'Message too big',
    description: 'The endpoint is terminating the connection because a data frame was received that is too large.'
  },
  MissingExtension: {
    value: 1010,
    name: 'Missing Extension',
    description: "The client is terminating the connection because it expected the server to negotiate one or more extension, but the server didn't."
  },
  InternalError: {
    value: 1011,
    name: 'Internal Error',
    description:
      'The server is terminating the connection because it encountered an unexpected condition that prevented it from fulfilling the request.'
  },
  ServiceRestart: {
    value: 1012,
    name: 'Service Restart',
    description: 'The server is terminating the connection because it is restarting.'
  },
  TryAgainLater: {
    value: 1013,
    name: 'Try Again Later',
    description:
      'The server is terminating the connection due to a temporary condition, e.g. it is overloaded and is casting off some of its clients.'
  },
  BadGateway: {
    value: 1014,
    name: 'Bad Gateway\t',
    description:
      'The server was acting as a gateway or proxy and received an invalid response from the upstream server. This is similar to 502 HTTP Status Code.'
  },
  TLSHandshake: {
    value: 1015,
    name: 'TLS Handshake',
    description:
      "Reserved. Indicates that the connection was closed due to a failure to perform a TLS handshake (e.g., the server certificate can't be verified)."
  },
  Reserved_1016_1999: { value: 1016, name: 'Reserved', description: 'Reserved for future use by the WebSocket standard.' },
  Reserved_2000_2999: { value: 2000, name: 'Reserved', description: 'Reserved for use by WebSocket extensions.' },
  Reserved_3000_3999: {
    value: 3000,
    name: 'Reserved',
    description:
      'Available for use by libraries and frameworks. May not be used by applications. Available for registration at the IANA via first-come, first-serve.'
  },
  Reserved_4000_4999: { value: 4000, name: 'Reserved', description: 'Available for use by applications.' },
  Reserved_12592: {
    value: 12592,
    name: 'Host was closed the websocket',
    description: 'Host was closed the websocket.'
  },
  Unknown: { value: -1, name: 'Unknown', description: 'Unknown Status code.' }
} as const satisfies Record<string, WebsocketStatus>;

const EXACT_MATCH: Record<number, WebsocketStatus> = {
  1000: STATUS_TABLE.NormalClosure,
  1001: STATUS_TABLE.GoingAway,
  1002: STATUS_TABLE.ProtocolError,
  1003: STATUS_TABLE.UnsupportedData,
  1004: STATUS_TABLE.Reserved_1004,
  1005: STATUS_TABLE.NoStatusRecvd,
  1006: STATUS_TABLE.AbnormalClosure,
  1007: STATUS_TABLE.InvalidFramePayloadData,
  1008: STATUS_TABLE.PolicyViolation,
  1009: STATUS_TABLE.MessageTooBig,
  1010: STATUS_TABLE.MissingExtension,
  1011: STATUS_TABLE.InternalError,
  1012: STATUS_TABLE.ServiceRestart,
  1013: STATUS_TABLE.TryAgainLater,
  1014: STATUS_TABLE.BadGateway,
  1015: STATUS_TABLE.TLSHandshake,
  12592: STATUS_TABLE.Reserved_12592
};

function resolveStatus(statusCode: number | string): WebsocketStatus {
  const code = Number(statusCode);
  if (code <= 999) return STATUS_TABLE.Reserved_0_999;
  if (code >= 1016 && code <= 1999) return STATUS_TABLE.Reserved_1016_1999;
  if (code >= 2000 && code <= 2999) return STATUS_TABLE.Reserved_2000_2999;
  if (code >= 3000 && code <= 3999) return STATUS_TABLE.Reserved_3000_3999;
  if (code >= 4000 && code <= 4999) return STATUS_TABLE.Reserved_4000_4999;
  return EXACT_MATCH[code] ?? STATUS_TABLE.Unknown;
}

/**
 * Ported from the legacy player’s Network/websocketStatusCode.js.
 *
 * NOTE: the legacy `case 1004:` branch reads `StatusCode.Reserved1004`
 * (missing underscore) — a dead key that resolves to `undefined`, so code
 * 1004 crashes in the legacy version instead of resolving to the "Reserved"
 * entry actually defined in its table. This looks like an unintentional typo
 * rather than a meaningful contract, so this port maps 1004 to its intended
 * `Reserved_1004` entry instead of reproducing the crash.
 */
export class WebsocketStatusCode {
  private readonly status: WebsocketStatus;

  constructor(statusCode: number | string) {
    this.status = resolveStatus(statusCode);
  }

  getDescription(): string {
    return this.status.description;
  }

  getStatusCode(): number {
    return this.status.value;
  }

  getName(): string {
    return this.status.name;
  }

  getObject(): WebsocketStatus {
    return this.status;
  }
}
