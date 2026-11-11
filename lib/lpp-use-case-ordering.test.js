'use strict';
const EventEmitter = require('node:events');
const path = require('node:path');
const sinon = require('sinon');
const { expect } = require('chai');

/**
 * Load a fresh copy of lpp-use-case.js with grpc-client / grpc-service replaced by fakes,
 * so the real LppUseCase (and real state machine) can be driven without a gRPC server.
 *
 * @param {object} csLppClient - Fake CS-LPP client; each method returns a Promise
 * @returns {{ LppUseCase: Function, restore: () => void }} Fresh module export and cleanup
 */
function loadWithFakes(csLppClient) {
    const grpcClientPath = require.resolve('./grpc-client');
    const modulePath = require.resolve('./lpp-use-case');
    const saved = [grpcClientPath, modulePath].map(p => [p, require.cache[p]]);

    require.cache[grpcClientPath] = {
        id: grpcClientPath,
        filename: grpcClientPath,
        loaded: true,
        exports: {
            makeClient: () => csLppClient,
            getEndpoint: () => 'fake',
            isTransportError: () => false,
            callUnary: (client, method, req) => client[method](req),
        },
        children: [],
        paths: [],
        path: path.dirname(grpcClientPath),
    };
    delete require.cache[modulePath];
    const { LppUseCase } = require('./lpp-use-case');

    return {
        LppUseCase,
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

describe('LppUseCase out-of-order limit responses', () => {
    let restore;
    let adapter;
    let stream;
    let reads;
    let onLimitUpdate;
    let lpp;

    beforeEach(async () => {
        reads = {};
        const pending = name => () => {
            const d = deferred();
            (reads[name] = reads[name] || []).push(d);
            return d.promise;
        };
        const csLppClient = {
            SetProductionNominalMax: async () => ({}),
            SetProductionLimit: async () => ({}),
            SetFailsafeProductionActivePowerLimit: async () => ({}),
            SetFailsafeDurationMinimum: async () => ({}),
            StartHeartbeat: async () => ({}),
            ProductionLimit: pending('limit'),
            FailsafeProductionActivePowerLimit: pending('failsafe'),
            close: () => {},
        };
        const loaded = loadWithFakes(csLppClient);
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
        lpp = new loaded.LppUseCase(
            adapter,
            { contractualProductionNominalMax: 4200 },
            { AddUseCase: async () => ({ instance_id: 'instance-1' }), SubscribeUseCaseEvents: () => stream },
            k => k,
            { onLimitUpdate },
        );
        await lpp.start();
    });

    afterEach(() => {
        lpp.stop();
        restore();
    });

    const limitResponse = (value, minutes, active = true) => ({
        load_limit: { is_active: active, value: -value, duration_nanoseconds: minutes * 60_000_000_000 },
    });
    const lastState = id => {
        const calls = adapter.setState.getCalls().filter(c => c.args[0] === id);
        return calls.length ? calls[calls.length - 1].args[1] : undefined;
    };
    const emit = event => stream.emit('data', { use_case_event: { event } });

    it('ordered replies end at the newer limit', async () => {
        emit('DataUpdateLimit');
        emit('DataUpdateLimit');
        await flush();
        reads.limit[0].resolve(limitResponse(3000, 10));
        await flush();
        reads.limit[1].resolve(limitResponse(1500, 5));
        await flush();
        expect(lastState('LPP.limit')).to.equal(1500);
        expect(lastState('LPP.limitDuration')).to.equal(5);
    });

    it('older response arriving after a newer one is discarded', async () => {
        emit('DataUpdateLimit');
        emit('DataUpdateLimit');
        await flush();
        reads.limit[1].resolve(limitResponse(1500, 5));
        await flush();
        const timersBefore = adapter.setTimeout.callCount;
        reads.limit[0].resolve(limitResponse(3000, 10));
        await flush();

        expect(lastState('LPP.limit')).to.equal(1500);
        expect(lastState('LPP.limitDuration')).to.equal(5);
        expect(onLimitUpdate.callCount).to.equal(1);
        expect(onLimitUpdate.lastCall.args[1]).to.equal(1500);
        expect(adapter.setTimeout.callCount).to.equal(timersBefore, 'obsolete response must not restart a timer');
    });

    it('older active response does not override a newer deactivation', async () => {
        emit('DataUpdateLimit');
        emit('DataUpdateLimit');
        await flush();
        reads.limit[1].resolve(limitResponse(0, 0, false));
        await flush();
        reads.limit[0].resolve(limitResponse(3000, 10));
        await flush();

        expect(lastState('LPP.limit')).to.equal(0);
        expect(onLimitUpdate.callCount).to.equal(1);
        expect(onLimitUpdate.lastCall.args[0]).to.equal(false);
    });

    it('response arriving after stop() has no effect', async () => {
        emit('DataUpdateLimit');
        await flush();
        lpp.stop();
        const writesBefore = adapter.setState.callCount;
        reads.limit[0].resolve(limitResponse(3000, 10));
        await flush();

        expect(adapter.setState.callCount).to.equal(writesBefore);
        expect(onLimitUpdate.called).to.equal(false);
    });

    it('older failsafe limit event response does not overwrite a newer one', async () => {
        emit('DataUpdateFailsafeProductionActivePowerLimit');
        emit('DataUpdateFailsafeProductionActivePowerLimit');
        await flush();
        reads.failsafe[1].resolve({ limit: -1000, is_changeable: false });
        await flush();
        const infoBefore = adapter.log.info.callCount;
        reads.failsafe[0].resolve({ limit: -2000, is_changeable: false });
        await flush();
        expect(adapter.log.debug.getCalls().some(c => /superseded/.test(c.args[0]))).to.equal(true);
        expect(adapter.log.info.callCount).to.equal(infoBefore);
    });

    it('failsafe-entry read finishing after a newer limit was applied is discarded', async () => {
        lpp.trigger('heartbeatDeactivatedLimit');
        lpp.trigger('heartbeatTimeout');
        expect(lpp.state).to.equal('failsafe');
        await flush();
        expect(reads.failsafe).to.have.length(1);

        // Controlbox sends a new limit; the heartbeat leaves failsafe
        emit('DataUpdateLimit');
        await flush();
        reads.limit[0].resolve(limitResponse(1500, 5));
        await flush();
        expect(lpp.state).to.equal('limited');
        const callsBefore = onLimitUpdate.callCount;

        // Late failsafe-entry response must not restore the failsafe value
        reads.failsafe[0].resolve({ limit: -4200, is_changeable: false });
        await flush();
        expect(lastState('LPP.limit')).to.equal(1500);
        expect(onLimitUpdate.callCount).to.equal(callsBefore);
    });
});
