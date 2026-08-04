export interface BufferManagerLike {
  change(status: BufferState): void;
}

export interface BufferControlMessage {
  errorCode: number;
  oldErrorCode: string;
  description: string;
  currentState?: string;
}

/** Common shape of the six playback buffer states (bufferStatus.js). */
export interface BufferState {
  isReadyToPop(): boolean;
  push(): boolean;
  pause(): BufferControlMessage | undefined;
  full(): BufferControlMessage | undefined;
  restart(): BufferControlMessage | undefined;
  clear(): void;
  resume(): BufferControlMessage | undefined;
  checkBufferLength?(): void;
}

export class InitState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return false;
  }
  push(): boolean {
    this.manager.change(new PlayState(this.manager));
    return true;
  }
  pause(): undefined {
    return undefined;
  }
  full(): undefined {
    return undefined;
  }
  restart(): undefined {
    return undefined;
  }
  clear(): void {}
  resume(): undefined {
    return undefined;
  }
}

export class PlayState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return true;
  }
  push(): boolean {
    return false;
  }
  pause(): undefined {
    this.manager.change(new PauseState(this.manager));
    return undefined;
  }
  full(): BufferControlMessage {
    this.manager.change(new WaitPauseState(this.manager));
    return { errorCode: 0x0500, oldErrorCode: '600', description: 'error' };
  }
  clear(): void {
    this.manager.change(new InitState(this.manager));
  }
  restart(): undefined {
    this.manager.change(new InitState(this.manager));
    return undefined;
  }
  resume(): undefined {
    return undefined;
  }
  checkBufferLength(): void {}
}

export class WaitPauseState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return true;
  }
  push(): boolean {
    return false;
  }
  pause(): undefined {
    this.manager.change(new FullState(this.manager));
    return undefined;
  }
  clear(): void {
    this.manager.change(new InitState(this.manager));
  }
  full(): undefined {
    return undefined;
  }
  restart(): undefined {
    return undefined;
  }
  resume(): undefined {
    return undefined;
  }
  checkBufferLength(): void {}
}

export class FullState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return true;
  }
  pause(): BufferControlMessage {
    this.manager.change(new FakePauseState(this.manager));
    return { errorCode: 0x0000, oldErrorCode: '200', currentState: 'Pause', description: 'BufferManager process PAUSE' };
  }
  restart(): BufferControlMessage {
    this.manager.change(new PlayState(this.manager));
    return { errorCode: 0x0501, oldErrorCode: '601', description: 'error' };
  }
  clear(): void {
    this.manager.change(new InitState(this.manager));
  }
  push(): boolean {
    return false;
  }
  resume(): undefined {
    return undefined;
  }
  full(): undefined {
    return undefined;
  }
}

export class FakePauseState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return false;
  }
  resume(): BufferControlMessage {
    this.manager.change(new FullState(this.manager));
    return { errorCode: 0x0000, oldErrorCode: '200', currentState: 'Resume', description: 'BufferManager process RESUME' };
  }
  clear(): void {
    this.manager.change(new InitState(this.manager));
  }
  push(): boolean {
    return false;
  }
  full(): undefined {
    return undefined;
  }
  restart(): undefined {
    return undefined;
  }
  pause(): undefined {
    return undefined;
  }
  checkBufferLength(): void {}
}

export class PauseState implements BufferState {
  constructor(private readonly manager: BufferManagerLike) {}
  isReadyToPop(): boolean {
    return false;
  }
  resume(): undefined {
    this.manager.change(new InitState(this.manager));
    return undefined;
  }
  clear(): void {
    this.manager.change(new InitState(this.manager));
  }
  push(): boolean {
    return false;
  }
  full(): undefined {
    return undefined;
  }
  restart(): undefined {
    return undefined;
  }
  pause(): undefined {
    return undefined;
  }
  checkBufferLength(): void {}
}
