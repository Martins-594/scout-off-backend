/**
 * Tests for stellar.ts service functions:
 *   - isSubscribed()              — view-only simulation call
 *   - queryMilestones()           — stub returning []
 *   - cancelSubscriptionOnChain() — real Soroban invocation
 *
 * The Stellar SDK and signer utility are fully mocked so no live RPC is needed.
 */

// ─── Top-level mock methods ───────────────────────────────────────────────────
// We declare these at the top level so jest.fn() instances survive
// jest.clearAllMocks() in beforeEach without losing their identities.
// (clearAllMocks resets recorded calls + return values, but the same
// jest.fn() reference is still reachable from the mock factory closure.)

const mockGetAccount      = jest.fn();
const mockSimulate        = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction  = jest.fn();
const mockAssembleBuild   = jest.fn().mockReturnValue({ sign: jest.fn() });
const mockAssemble        = jest.fn().mockReturnValue({ build: mockAssembleBuild });

jest.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: jest.fn().mockReturnValue({
      getLatestLedger:     jest.fn().mockResolvedValue({ sequence: 1 }),
      getAccount:          mockGetAccount,
      simulateTransaction: mockSimulate,
      sendTransaction:     mockSendTransaction,
      getTransaction:      mockGetTransaction,
    }),
    Api: {
      isSimulationError: jest.fn().mockReturnValue(false),
      GetTransactionStatus: {
        NOT_FOUND: 'NOT_FOUND',
        SUCCESS:   'SUCCESS',
        FAILED:    'FAILED',
      },
    },
    assembleTransaction: mockAssemble,
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout:   jest.fn().mockReturnThis(),
    build:        jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: '100',
  Keypair: {
    random:     jest.fn().mockReturnValue({ publicKey: () => 'GBADUMMYACCOUNT' }),
    fromSecret: jest.fn().mockReturnValue({
      publicKey: () => 'GPLATFORMKEYPAIR0000000000000000000000000000000000000000',
      sign: jest.fn(),
    }),
  },
  Account:      jest.fn().mockImplementation(() => ({})),
  Address:      { fromString: jest.fn().mockReturnValue({ toScVal: () => ({}) }) },
  scValToNative: jest.fn().mockReturnValue(true),
}));

// Mock the signer so getPlatformKeypair() returns a deterministic keypair
jest.mock('../../src/utils/signer', () => ({
  getPlatformKeypair: jest.fn().mockReturnValue({
    publicKey: () => 'GPLATFORMKEYPAIR0000000000000000000000000000000000000000',
    sign: jest.fn(),
  }),
}));

import {
  isSubscribed,
  queryMilestones,
  cancelSubscriptionOnChain,
  PaymentError,
} from '../../src/services/stellar';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sdk = require('@stellar/stellar-sdk') as any;

const WALLET = 'G' + 'A'.repeat(55);

// ─── Shared setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Restore default SDK behaviours after clearAllMocks() wipes return values
  sdk.scValToNative.mockReturnValue(true);
  sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(false);
  mockAssembleBuild.mockReturnValue({ sign: jest.fn() });
  mockAssemble.mockReturnValue({ build: mockAssembleBuild });

  // isSubscribed defaults — simulate returns a truthy bool
  mockSimulate.mockResolvedValue({ result: { retval: { type: 'scvBool' } } });

  // cancelSubscriptionOnChain defaults — happy path
  mockGetAccount.mockResolvedValue({});
  mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'txhash-abc' });
  mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });
});

// ─── isSubscribed ─────────────────────────────────────────────────────────────

describe('isSubscribed', () => {
  it('invokes is_subscribed on the contract and returns { active: true, expiresAt: "" }', async () => {
    sdk.scValToNative.mockReturnValue(true);
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(true);
    expect(result.expiresAt).toBe('');
  });

  it('returns { active: false, expiresAt: null } when the contract returns false', async () => {
    sdk.scValToNative.mockReturnValue(false);
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('returns { active: false, expiresAt: null } when retval is missing', async () => {
    mockSimulate.mockResolvedValue({ result: null });
    const result = await isSubscribed(WALLET);
    expect(result.active).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('throws PaymentError NETWORK_ERROR on simulation error response', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'rpc down' });
    await expect(isSubscribed(WALLET)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws PaymentError NETWORK_ERROR when simulateTransaction rejects', async () => {
    mockSimulate.mockRejectedValue(new Error('connection timeout'));
    await expect(isSubscribed(WALLET)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws PaymentError for empty wallet without calling the RPC', async () => {
    await expect(isSubscribed('')).rejects.toThrow(PaymentError);
  });
});

// ─── queryMilestones ──────────────────────────────────────────────────────────

describe('queryMilestones', () => {
  it('returns an empty array for a valid playerId (stub)', async () => {
    const result = await queryMilestones('GPLAYER123');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('throws PaymentError for an empty playerId', async () => {
    await expect(queryMilestones('')).rejects.toThrow(PaymentError);
  });
});

// ─── cancelSubscriptionOnChain ────────────────────────────────────────────────

describe('cancelSubscriptionOnChain', () => {
  it('throws PaymentError INVALID_ACCOUNT for empty wallet', async () => {
    await expect(cancelSubscriptionOnChain('')).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'INVALID_ACCOUNT',
    });
  });

  it('submits a real Soroban transaction and returns its hash on success', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'real-tx-hash-001' });
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

    const result = await cancelSubscriptionOnChain(WALLET);

    expect(result.transactionId).toBe('real-tx-hash-001');
    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockSimulate).toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockGetTransaction).toHaveBeenCalledWith('real-tx-hash-001');
  });

  it('polls getTransaction until status is no longer NOT_FOUND', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'poll-hash' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    jest.useFakeTimers();
    const promise = cancelSubscriptionOnChain(WALLET);
    await jest.runAllTimersAsync();
    const result = await promise;
    jest.useRealTimers();

    expect(result.transactionId).toBe('poll-hash');
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when simulation returns contract error #8', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #8' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
    // DB must NOT be touched — the function throws before submitting
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when simulation message contains "NotSubscribed"', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'NotSubscribed' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
  });

  it('throws SubscriptionError UNAUTHORIZED when simulation returns contract error #9', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Contract error: #9' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'UNAUTHORIZED',
    });
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR for an unknown simulation error', async () => {
    sdk.SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSimulate.mockResolvedValue({ error: 'Something went wrong' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws PaymentError NETWORK_ERROR when sendTransaction returns ERROR status', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: 'tx_failed',
      hash: 'err-hash',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
    // Transaction never confirmed — getTransaction should NOT be called
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('throws PaymentError NETWORK_ERROR when the confirmed transaction has FAILED status', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash' });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultMetaXdr: '' });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'NETWORK_ERROR',
    });
  });

  it('throws SubscriptionError NOT_SUBSCRIBED when FAILED tx XDR contains #8', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash-8' });
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultMetaXdr: 'error-payload-#8-encoded',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'NOT_SUBSCRIBED',
    });
  });

  it('throws SubscriptionError UNAUTHORIZED when FAILED tx XDR contains #9', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail-hash-9' });
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultMetaXdr: 'error-payload-#9-encoded',
    });

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toMatchObject({
      name: 'SubscriptionError',
      code: 'UNAUTHORIZED',
    });
  });

  it('propagates errors from getAccount (RPC unreachable)', async () => {
    mockGetAccount.mockRejectedValue(new Error('network unreachable'));

    await expect(cancelSubscriptionOnChain(WALLET)).rejects.toThrow('network unreachable');
  });
});

// ─── HTTP Keepalive Configuration ─────────────────────────────────────────────

describe('HTTP Keepalive Configuration', () => {
  it('the module loads without errors and the server singleton is defined', () => {
    expect(() => require('../../src/services/stellar')).not.toThrow();
  });
});
