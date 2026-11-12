'use strict';
const EventEmitter = require('node:events');
const path = require('node:path');
const sinon = require('sinon');
const { expect } = require('chai');

/**
 * Load a fresh copy of lpc-use-case.js with grpc-client / grpc-service replaced by fakes,
 * so the real LpcUseCase (and real state machine) can be driven without a gRPC server.
 *
 * @param {object} csLpcClient - Fake CS-LPC client; each method returns a Promise
 * @returns {{ LpcUseCase: Function, restore: () => void }} Fresh module export and cleanup
 */
function loadWithFakes(csLpcClient) {
    const grpcClientPath = require.resolve('./grpc-client');
    const grpcServicePath = require.resolve('./grpc-service');
    const modulePath = require.resolve('./lpc-use-case');
    const saved = [grpcClientPath, grpcServicePath, modulePath].map(p => [p, require.cache[p]]);

    const fakeModule = (p, exports) => {
        require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [], path: path.dirname(p) };
    };
    fakeModule(grpcClientPath, {
        makeClient: () => csLpcClient,
        getEndpoint: () => 'fake',
        isTransportError: () => false,
        callUnary: (client, method, req) => client[method](req),
    });
    fakeModule(grpcServicePath, { addCsLpcUseCase: async () => 'instance-1' });
    delete require.cache[modulePath];
    const { LpcUseCase } = require('./lpc-use-case');

    return {
        LpcUseCase,
        restore: () => {
            for (const [p, entry] of saved) {
                if (entry) {
                    require.cache[p] = entry;
                } else {
                    delete require.cache[p];
                }
            }
        },
    };
}

/** @returns {{ promise: Promise<any>, resolve: (v: any) => void }} A manually resolvable promise */
function deferred() {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
}

const flush = () => new Promise(r => setImmediate(r));

describe('LpcUseCase out-of-order ConsumptionLimit responses', () => {
    let restore;
    let adapter;
    let stream;
    let reads;
    let onLimitUpdate;
    let lpc;

    beforeEach(async () => {
        reads = [];
        const csLpcClient = {
            SetConsumptionNominalMax: async () => ({}),
            SetConsumptionLimit: async () => ({}),
            SetFailsafeConsumptionActivePowerLimit: async () => ({}),
            SetFailsafeDurationMinimum: async () => ({}),
            StartHeartbeat: async () => ({}),
            ConsumptionLimit: () => {
                const d = deferred();
                reads.push(d);
                return d.promise;
            },
            FailsafeConsumptionActivePowerLimit: () => {
                const d = deferred();
                reads.push(d);
                return d.promise;
            },
            close: () => {},
        };
        const loaded = loadWithFakes(csLpcClient);
        restore = loaded.restore;

        stream = new EventEmitter();
        stream.cancel = sinon.stub();
        adapter = {
            extendObjectAsync: sinon.stub().resolves(),
            setStateAsync: sinon.stub().resolves(),
            setState: sinon.stub(),
            getStateAsync: sinon.stub().resolves(null),
            setTimeout: sinon.stub().returns(42),
            clearTimeout: sinon.stub(),
            setInterval: sinon.stub().returns(99),
            clearInterval: sinon.stub(),
            log: { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        };
        onLimitUpdate = sinon.stub().resolves();
        lpc = new loaded.LpcUseCase(
            adapter,
            { contractualConsumptionNominalMax: 12000 },
            { SubscribeUseCaseEvents: () => stream },
            k => k,
            { onLimitUpdate },
        );
        await lpc.start();
    });

    afterEach(() => {
        lpc.stop();
        restore();
    });

    const limitResponse = (value, minutes, active = true) => ({
        load_limit: { is_active: active, value, duration_nanoseconds: minutes * 60_000_000_000 },
    });
    const lastState = id => {
        const calls = adapter.setState.getCalls().filter(c => c.args[0] === id);
        return calls.length ? calls[calls.length - 1].args[1] : undefined;
    };

    it('ordered replies end at the newer limit', async () => {
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        await flush();
        reads[0].resolve(limitResponse(9000, 10));
        await flush();
        reads[1].resolve(limitResponse(4200, 5));
        await flush();
        expect(lastState('LPC.limit')).to.equal(4200);
        expect(lastState('LPC.limitDuration')).to.equal(5);
    });

    it('older response arriving after a newer one is discarded', async () => {
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        await flush();
        reads[1].resolve(limitResponse(4200, 5));
        await flush();
        const timersBefore = adapter.setTimeout.callCount;
        reads[0].resolve(limitResponse(9000, 10));
        await flush();

        expect(lastState('LPC.limit')).to.equal(4200);
        expect(lastState('LPC.limitDuration')).to.equal(5);
        expect(onLimitUpdate.callCount).to.equal(1);
        expect(onLimitUpdate.lastCall.args[1]).to.equal(4200);
        expect(adapter.setTimeout.callCount).to.equal(timersBefore, 'obsolete response must not restart a timer');
    });

    it('older active response does not override a newer deactivation', async () => {
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        await flush();
        reads[1].resolve(limitResponse(0, 0, false));
        await flush();
        reads[0].resolve(limitResponse(9000, 10));
        await flush();

        expect(lastState('LPC.limit')).to.equal(0);
        expect(onLimitUpdate.callCount).to.equal(1);
        expect(onLimitUpdate.lastCall.args[0]).to.equal(false);
    });

    it('response arriving after stop() has no effect', async () => {
        stream.emit('data', { use_case_event: { event: 'DataUpdateLimit' } });
        await flush();
        lpc.stop();
        const writesBefore = adapter.setState.callCount;
        reads[0].resolve(limitResponse(9000, 10));
        await flush();

        expect(adapter.setState.callCount).to.equal(writesBefore);
        expect(onLimitUpdate.called).to.equal(false);
    });

    it('older failsafe limit response is discarded after a newer one', async () => {
        lpc.trigger('heartbeatDeactivatedLimit');
        lpc.trigger('heartbeatTimeout');
        expect(lpc.state).to.equal('failsafe');
        await flush();
        // Entering failsafe may itself start reads; only track the two started below
        const first = reads.length;
        stream.emit('data', { use_case_event: { event: 'DataUpdateFailsafeConsumptionActivePowerLimit' } });
        stream.emit('data', { use_case_event: { event: 'DataUpdateFailsafeConsumptionActivePowerLimit' } });
        await flush();
        reads[first + 1].resolve({ limit: 3000, is_changeable: false });
        await flush();
        reads[first].resolve({ limit: 9000, is_changeable: false });
        await flush();

        expect(lastState('LPC.limit')).to.equal(3000);
    });
});
