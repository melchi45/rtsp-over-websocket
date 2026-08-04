export interface RtspStatus {
  value: number;
  name: string;
  description: string;
}

const STATUS_TABLE: Record<string, RtspStatus> = {
  Continue: { value: 100, name: 'Continue', description: 'RTSP 100 Continue' },
  OK: { value: 200, name: 'OK', description: 'RTSP 200 OK' },
  Created: { value: 201, name: 'Created', description: 'RTSP 201 Created' },
  LowonStorageSpace: { value: 250, name: 'Low on Storage Space', description: 'RTSP 250 Low on Storage Space' },
  MultipleChoices: { value: 300, name: 'Multiple Choices', description: 'RTSP 300 Multiple Choices' },
  MovedPermanently: { value: 301, name: 'Moved Permanently', description: 'RTSP 301 Moved Permanently' },
  MovedTemporarily: { value: 302, name: 'Moved Temporarily', description: 'RTSP 302 Moved Temporarily' },
  SeeOther: { value: 303, name: 'See Other', description: 'RTSP 303 See Other' },
  NotModified: { value: 304, name: 'Not Modified', description: 'RTSP 304 Not Modified' },
  UseProxy: { value: 305, name: 'Use Proxy', description: 'RTSP 305 Use Proxy' },
  BadRequest: { value: 400, name: 'Bad Request', description: 'RTSP 400 Bad Request' },
  Unauthorized: { value: 401, name: 'Unauthorized', description: 'RTSP 401 Unauthorized' },
  PaymentRequired: { value: 402, name: 'Payment Required', description: 'RTSP 402 Payment Required' },
  Forbidden: { value: 403, name: 'Forbidden', description: 'RTSP 403 Forbidden' },
  NotFound: { value: 404, name: 'Not Found', description: 'RTSP 404 Not Found' },
  MethodNotAllowed: { value: 405, name: 'Method Not Allowed', description: 'RTSP 405 Method Not Allowed' },
  NotAcceptable: { value: 406, name: 'Not Acceptable', description: 'RTSP 406 Not Acceptable' },
  ProxyAuthenticationRequired: {
    value: 407,
    name: 'Proxy Authentication Required',
    description: 'RTSP 407 Proxy Authentication Required'
  },
  RequestTimeout: { value: 408, name: 'Request Time-out', description: 'RTSP 408 Request Time-out' },
  Gone: { value: 410, name: 'Gone', description: 'RTSP 410 Gone' },
  LengthRequired: { value: 411, name: 'Length Required', description: 'RTSP 411 Length Required' },
  PreconditionFailed: { value: 412, name: 'Precondition Failed', description: 'RTSP 412 Precondition Failed' },
  RequestEntityTooLarge: {
    value: 413,
    name: 'Request Entity Too Large',
    description: 'RTSP 413 Request Entity Too Large'
  },
  RequestURITooLarge: { value: 414, name: 'Request-URI Too Large', description: 'RTSP 414 Request-URI Too Large' },
  UnsupportedMediaType: { value: 415, name: 'Unsupported Media Type', description: 'RTSP 415 Unsupported Media Type' },
  ParameterNotUnderstood: {
    value: 451,
    name: 'Parameter Not Understood',
    description: 'RTSP 451 Parameter Not Understood'
  },
  ConferenceNotFound: { value: 452, name: 'Conference Not Found', description: 'RTSP 452 Conference Not Found' },
  NotEnoughBandwidth: { value: 453, name: 'Not Enough Bandwidth', description: 'RTSP 453 Not Enough Bandwidth' },
  SessionNotFound: { value: 454, name: 'Session Not Found', description: 'RTSP 454 Session Not Found' },
  MethodNotValidinThisState: {
    value: 455,
    name: 'Method Not Valid in This State',
    description: 'RTSP 455 Method Not Valid in This State'
  },
  HeaderFieldNotValidforResource: {
    value: 456,
    name: 'Header Field Not Valid for Resource',
    description: 'RTSP 456 Header Field Not Valid for Resource'
  },
  InvalidRange: { value: 457, name: 'Invalid Range', description: 'RTSP 457 Invalid Range' },
  ParameterIsReadOnly: { value: 458, name: 'Parameter Is Read-Only', description: 'RTSP 458 Parameter Is Read-Only' },
  AggregateOperationNotAllowed: {
    value: 459,
    name: 'Aggregate operation not allowed',
    description: 'RTSP 459 Aggregate operation not allowed'
  },
  OnlyAggregateOperationAllowed: {
    value: 460,
    name: 'Only aggregate operation allowed',
    description: 'RTSP 460 Only aggregate operation allowed'
  },
  UnsupportedTransport: { value: 461, name: 'Unsupported transport', description: 'RTSP 461 Unsupported transport' },
  DestinationUnreachable: {
    value: 462,
    name: 'Aggregate operation not allowed',
    description: 'RTSP 462 Destination unreachable'
  },
  KeyManagementFailure: {
    value: 463,
    name: 'Key management Failure',
    description: 'RTSP 463 Key management Failure'
  },
  AccountBlocked: { value: 490, name: 'Account Blocked', description: 'RTSP 490 Account Blocked' },
  InternalServerError: { value: 500, name: 'Internal Server Error', description: 'RTSP 500 Internal Server Error' },
  NotImplemented: { value: 501, name: 'Not Implemented', description: 'RTSP 501 Not Implemented' },
  BadGateway: { value: 502, name: 'Bad Gateway', description: 'RTSP 502 Bad Gateway' },
  ServiceUnavailable: { value: 503, name: 'Service Unavailable', description: 'RTSP 503 Service Unavailable' },
  GatewayTimeout: { value: 504, name: 'Gateway Time-out', description: 'RTSP 504 Gateway Time-out' },
  RTSPVersionNotSupported: {
    value: 505,
    name: 'RTSP Version not supported',
    description: 'RTSP 505 RTSP Version not supported'
  },
  OptionNotSupported: { value: 551, name: 'Option not supported', description: 'RTSP 551 Option not supported' },
  MaximumUserReached: {
    value: 560,
    name: 'Maximum user Reached',
    description: 'RTSP 560 Maximum user Reached for HTW NVR Device'
  },
  InvalidRequestSearchTime: {
    value: 702,
    name: 'Invalid Request Search Time',
    description: 'RTSP 702 Invalid Request Search Time'
  },
  Unknown: { value: -1, name: 'Unknown', description: 'RTSP -1 Unknown' }
};

const BY_VALUE: Record<number, RtspStatus> = Object.fromEntries(
  Object.values(STATUS_TABLE).map((status) => [status.value, status])
);

/**
 * Ported from the legacy player’s Network/rtspStatusCode.
 *
 * The legacy implementation assigns `Constructor.prototype.status = ...`
 * rather than `this.status = ...`, but `Constructor` is a function declared
 * fresh inside the outer `RtspStatusCode(...)` factory on every call (and
 * instantiated exactly once per call), so each instance still ends up with
 * its own independent prototype object — this is not a cross-instance
 * state-sharing bug, just an unusual way of writing plain per-instance state.
 */
export class RtspStatusCode {
  private readonly status: RtspStatus;

  constructor(statusCode: number | string | undefined) {
    this.status = BY_VALUE[Number(statusCode)] ?? STATUS_TABLE.Unknown;
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

  getObject(): RtspStatus {
    return this.status;
  }
}
