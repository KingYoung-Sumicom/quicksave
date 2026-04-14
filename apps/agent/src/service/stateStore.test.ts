import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import type { ServiceState } from './types.js';

vi.mock('fs');
vi.mock('./singleton.js', () => ({
  getStateDir: () => '/fake/state',
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

// Import after mocks are set up
const { readServiceState, writeServiceState, removeServiceState } = await import('./stateStore.js');

const fakeState: ServiceState = {
  pid: 12345,
  version: '1.0.0',
  ipcVersion: 1,
  buildId: 'test-abc',
  startedAt: '2026-01-01T00:00:00Z',
  lastHeartbeatAt: '2026-01-01T00:01:00Z',
  socketPath: '/tmp/test.sock',
  agentId: 'agent-123',
  publicKey: 'pk-abc',
  signalingServer: 'wss://signal.example.com',
  connectionState: 'connected',
  peerCount: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readServiceState', () => {
  it('returns null when file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(readServiceState()).toBeNull();
  });

  it('reads and parses service.json when it exists', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(fakeState));
    const result = readServiceState();
    expect(result).toEqual(fakeState);
    expect(mockedReadFileSync).toHaveBeenCalledWith('/fake/state/service.json', 'utf-8');
  });

  it('returns null when JSON is invalid', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not-valid-json{{{');
    expect(readServiceState()).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(readServiceState()).toBeNull();
  });
});

describe('writeServiceState', () => {
  it('writes state as pretty-printed JSON', () => {
    writeServiceState(fakeState);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      '/fake/state/service.json',
      JSON.stringify(fakeState, null, 2),
    );
  });
});

describe('removeServiceState', () => {
  it('removes the service.json file', () => {
    removeServiceState();
    expect(mockedUnlinkSync).toHaveBeenCalledWith('/fake/state/service.json');
  });

  it('ignores ENOENT errors', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockedUnlinkSync.mockImplementation(() => { throw err; });
    expect(() => removeServiceState()).not.toThrow();
  });

  it('rethrows non-ENOENT errors', () => {
    const err = new Error('EACCES') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    mockedUnlinkSync.mockImplementation(() => { throw err; });
    expect(() => removeServiceState()).toThrow('EACCES');
  });
});
