'use strict';

const fc = require('fast-check');
const chai = require('chai');
const sinon = require('sinon');
const {
    LppUseCase,
    LPP_STATE,
    LPP_TRANSITIONS,
    shouldApproveLimit,
    resetManualLimits,
    filterDuplicateSkis,
} = require('./lpp-use-case');

const { expect } = chai;

/**
 * Create a mock ioBroker adapter with stubbed methods required by LppUseCase.
 */
function createMockAdapter() {
    return {
        extendObjectAsync: sinon.stub().resolves(),
        setState: sinon.stub(),
        setStateAsync: sinon.stub().resolves(),
        getStateAsync: sinon.stub().resolves(null),
        setTimeout: sinon.stub().returns(42),
        clearTimeout: sinon.stub(),
        setInterval: sinon.stub().returns(43),
        clearInterval: sinon.stub(),
        log: {
            debug: sinon.stub(),
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
        },
    };
}

/**
 * Build a path map: for each state, find a sequence of transitions from init
 * that reaches that state. Used to set up the FSM before testing a specific transition.
 */
function buildPathsFromInit() {
    // BFS to find shortest path from init to each state
    const paths = {};
    paths[LPP_STATE.INIT] = [];

    // Build an adjacency list from the transition table (excluding wildcard restart)
    const nonWildcardTransitions = LPP_TRANSITIONS.filter(t => t.from !== '*');

    const queue = [LPP_STATE.INIT];
    const visited = new Set([LPP_STATE.INIT]);

    while (queue.length > 0) {
        const current = queue.shift();
        const outgoing = nonWildcardTransitions.filter(t => t.from === current);

        for (const t of outgoing) {
            if (!visited.has(t.to)) {
                visited.add(t.to);
                paths[t.to] = [...paths[current], t.name];
                queue.push(t.to);
            }
        }
    }

    return paths;
}

const PATHS_FROM_INIT = buildPathsFromInit();

/**
 * Navigate a fresh LppUseCase instance to the given target state
 * by triggering a pre-computed sequence of transitions from init.
 */
function navigateToState(lpp, targetState) {
    if (targetState === '*') {
        // For wildcard transitions, the FSM is already in init
        return;
    }
    const path = PATHS_FROM_INIT[targetState];
    if (!path) {
        throw new Error(`No path from init to state: ${targetState}`);
    }
    for (const transitionName of path) {
        const result = lpp.trigger(transitionName);
        if (!result) {
            throw new Error(`Failed to trigger transition '${transitionName}' while navigating to '${targetState}'`);
        }
    }
}

// Filter transitions for the property test:
// For the wildcard restart transition, we test it from every concrete state
const concreteTransitions = LPP_TRANSITIONS.filter(t => t.from !== '*');
const wildcardTransitions = LPP_TRANSITIONS.filter(t => t.from === '*');
const allStates = Object.values(LPP_STATE);

// Expand wildcard transitions into concrete (state, transition) pairs
const expandedTransitions = [
    ...concreteTransitions,
    ...wildcardTransitions.flatMap(t => allStates.map(state => ({ name: t.name, from: state, to: t.to }))),
];

describe('Feature: add-lpp-use-case, Property 1: LPP FSM Transition Correctness', () => {
    /**
     * Validates: Requirements 3.1, 3.2, 3.5, 9.3
     *
     * For any valid (state, transition) pair from the LPP transition table,
     * triggering the transition SHALL produce the correct target state.
     */
    it('every valid (state, transition) pair produces the correct target state', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(fc.constantFrom(...expandedTransitions), transition => {
                const adapter = createMockAdapter();
                const config = {};
                const controlClient = {};
                const translate = key => key;
                const lpp = new LppUseCase(adapter, config, controlClient, translate);

                // Navigate to the source state
                navigateToState(lpp, transition.from);

                // Verify we're in the expected source state
                expect(lpp.state).to.equal(transition.from);

                // Trigger the transition
                const result = lpp.trigger(transition.name);

                // The transition should succeed
                expect(result).to.equal(true);

                // Verify the FSM state reflects the correct target state
                expect(lpp.state).to.equal(transition.to);
            }),
            { numRuns: 100 },
        );
    });

    it('the state property always reflects the current FSM state after any valid transition', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(fc.constantFrom(...expandedTransitions), transition => {
                const adapter = createMockAdapter();
                const lpp = new LppUseCase(adapter, {}, {}, key => key);

                // Navigate to source state
                navigateToState(lpp, transition.from);

                // Trigger and verify state getter returns target
                lpp.trigger(transition.name);
                expect(lpp.state).to.equal(transition.to);
            }),
            { numRuns: 100 },
        );
    });
});

describe('Feature: add-lpp-use-case, Property 2: Production Limit Approval Logic', () => {
    /**
     * Validates: Requirements 2.3
     *
     * For any set of configured LPP energy guards with arbitrary failsafe limit values,
     * and any incoming pending production limit value (positive, sign-converted at boundary),
     * the adapter SHALL approve the limit if and only if the limit value is greater than or
     * equal to the sum of all guard failsafe limits; otherwise it SHALL deny the limit.
     */
    it('approves iff pendingLimit >= sum(guardFailsafeLimits)', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(
                fc.array(fc.float({ min: 0, max: 10000, noNaN: true }), { minLength: 0, maxLength: 10 }),
                fc.float({ min: 0, max: 50000, noNaN: true }),
                (guardFailsafeLimits, pendingLimit) => {
                    const failsafeSum = guardFailsafeLimits.reduce((sum, limit) => sum + limit, 0);
                    const result = shouldApproveLimit(pendingLimit, guardFailsafeLimits);

                    if (pendingLimit >= failsafeSum) {
                        expect(result).to.equal(
                            true,
                            `Expected approval: ${pendingLimit} >= failsafeSum=${failsafeSum}`,
                        );
                    } else {
                        expect(result).to.equal(false, `Expected denial: ${pendingLimit} < failsafeSum=${failsafeSum}`);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('approves when no guards are configured (empty array, sum is 0)', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(fc.float({ min: 0, max: 50000, noNaN: true }), pendingLimit => {
                const result = shouldApproveLimit(pendingLimit, []);
                expect(result).to.equal(true, `Expected approval with no guards: ${pendingLimit} >= 0`);
            }),
            { numRuns: 100 },
        );
    });
});

describe('Feature: add-lpp-use-case, Property 3: Production Limit Distribution', () => {
    const { distributeProductionLimit } = require('./lpp-use-case');

    const guardArb = fc.record({
        pct: fc.float({ min: 0, max: 200, noNaN: true }),
        connected: fc.boolean(),
        failsafeLimit: fc.float({ min: 0, max: 5000, noNaN: true }),
    });

    const guardsArb = fc.array(guardArb, { minLength: 1, maxLength: 8 });
    const totalLimitArb = fc.float({ min: 1, max: 50000, noNaN: true });

    /**
     * Validates: Requirements 5.1, 5.2, 5.4, 5.6
     *
     * For any set of LPP energy guards with arbitrary percentage values and connection states,
     * and any active production limit value, the adapter SHALL:
     * - Skip disconnected guards from proportional distribution
     * - Scale percentages proportionally if their sum exceeds 100%
     * - Redistribute disconnected guards' shares proportionally among connected guards
     * - The sum of all distributed limits to connected guards SHALL not exceed the total limit
     *   (except for failsafe floor adjustments)
     */
    it('disconnected guards have skip=true, connected guards have skip=false', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(totalLimitArb, guardsArb, (totalLimit, guards) => {
                const results = distributeProductionLimit(totalLimit, guards);

                for (let i = 0; i < guards.length; i++) {
                    if (!guards[i].connected) {
                        expect(results[i].skip).to.equal(true, `Guard ${i} is disconnected but skip is not true`);
                    } else {
                        expect(results[i].skip).to.equal(false, `Guard ${i} is connected but skip is not false`);
                    }
                }
            }),
            { numRuns: 100 },
        );
    });

    it('result array length equals input guards length', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(totalLimitArb, guardsArb, (totalLimit, guards) => {
                const results = distributeProductionLimit(totalLimit, guards);
                expect(results.length).to.equal(guards.length);
            }),
            { numRuns: 100 },
        );
    });

    it('each connected guard effectiveLimit >= their failsafeLimit', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(totalLimitArb, guardsArb, (totalLimit, guards) => {
                const results = distributeProductionLimit(totalLimit, guards);

                for (let i = 0; i < guards.length; i++) {
                    if (guards[i].connected) {
                        expect(results[i].effectiveLimit).to.be.at.least(
                            guards[i].failsafeLimit,
                            `Connected guard ${i} effectiveLimit (${results[i].effectiveLimit}) < failsafeLimit (${guards[i].failsafeLimit})`,
                        );
                    }
                }
            }),
            { numRuns: 100 },
        );
    });

    it('sum of connected guard effectiveLimits does not exceed totalLimit', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(totalLimitArb, guardsArb, (totalLimit, guards) => {
                const results = distributeProductionLimit(totalLimit, guards);

                const connectedSum = results.reduce(
                    (sum, r, i) => (guards[i].connected ? sum + r.effectiveLimit : sum),
                    0,
                );

                const connectedIndices = guards.map((g, i) => (g.connected ? i : -1)).filter(i => i >= 0);

                if (connectedIndices.length === 0) {
                    expect(connectedSum).to.equal(0);
                    return;
                }

                // The sum of effective limits must not exceed the total limit
                // plus the 1W minimum floor allowance per connected guard.
                // Each connected guard is floored at max(failsafeLimit, 1W), so the
                // sum can exceed totalLimit by up to 1W per guard with a sub-1W share.
                const failsafeSum = connectedIndices.reduce((sum, i) => sum + guards[i].failsafeLimit, 0);
                const floorAllowance = connectedIndices.length; // 1W per connected guard
                const expectedMax = Math.max(totalLimit, failsafeSum) + floorAllowance;
                const tolerance = 1e-6 * Math.abs(expectedMax) + 1e-10;

                expect(connectedSum).to.be.at.most(
                    expectedMax + tolerance,
                    `Connected sum ${connectedSum} exceeds max(totalLimit=${totalLimit}, failsafeSum=${failsafeSum}) + ${floorAllowance}`,
                );
            }),
            { numRuns: 100 },
        );
    });
});

describe('Feature: add-lpp-use-case, Property 4: Effective Limit Calculation', () => {
    const { distributeProductionLimit } = require('./lpp-use-case');

    /**
     * Validates: Requirements 5.5
     *
     * For a single connected guard, it receives its configured percentage of totalLimit
     * as its effective limit, unless that is below its failsafe limit (then failsafe wins).
     */
    it('single connected guard receives its percentage of totalLimit (or failsafe if larger)', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(
                fc.float({ min: 0, max: 50000, noNaN: true }),
                fc.float({ min: 0, max: 100, noNaN: true }),
                fc.float({ min: 0, max: 10000, noNaN: true }),
                (totalLimit, effectivePercentage, failsafeLimit) => {
                    const guards = [{ pct: effectivePercentage, connected: true, failsafeLimit }];
                    const result = distributeProductionLimit(totalLimit, guards);

                    // Guard gets max(pct% of totalLimit, failsafeLimit, 1)
                    // The 1W floor ensures users can distinguish "limited" from "no limit"
                    const expectedLimit = Math.max((effectivePercentage * totalLimit) / 100, failsafeLimit, 1);

                    const diff = Math.abs(result[0].effectiveLimit - expectedLimit);
                    const tolerance = 1e-6 * Math.abs(expectedLimit) + 1e-10;

                    expect(diff).to.be.at.most(
                        tolerance,
                        `effectiveLimit=${result[0].effectiveLimit} should equal ` +
                            `max(${effectivePercentage}% * ${totalLimit}, ${failsafeLimit}) = ${expectedLimit}`,
                    );
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('Feature: add-lpp-use-case, Property 8: Control Box Activation Resets Manual Limits', () => {
    /**
     * Validates: Requirements 14.3
     *
     * For any set of LPP EEBUS energy guards with arbitrary non-zero manual limit values,
     * when the control box production limit transitions from inactive to active,
     * all guard manual limits SHALL be reset to zero.
     */
    it('all manual limits are reset to zero when control box limit becomes active', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 8 }),
                async manualLimits => {
                    const adapter = createMockAdapter();

                    // Create mock EEBUS guards with non-zero manual limits
                    const guards = manualLimits.map((limit, idx) => ({
                        name: `PV_${idx}`,
                        basePath: `LPP.EnergyGuards.Guard_PV_${idx}`,
                        ski: `ski-${idx}`,
                        egLpcClient: { close: sinon.stub() }, // mock client
                        isConnected: () => true,
                        manualLimit: limit, // arbitrary non-zero manual limit
                    }));

                    // Set up manual limit timers for each guard (simulating active timers)
                    const manualLimitTimers = new Map();
                    for (const guard of guards) {
                        manualLimitTimers.set(guard.name, 99); // dummy timer ID
                    }

                    // Mock callUnary to succeed (WriteProductionLimit deactivate)
                    const callUnaryFn = sinon.stub().resolves({});

                    // Act: reset manual limits (simulates control box becoming active)
                    await resetManualLimits(guards, adapter, manualLimitTimers, callUnaryFn);

                    // Verify: setStateAsync was called with (basePath + '.manualLimit', 0, true) for each guard
                    for (const guard of guards) {
                        const expectedPath = `${guard.basePath}.manualLimit`;
                        const matchingCall = adapter.setStateAsync
                            .getCalls()
                            .find(call => call.args[0] === expectedPath && call.args[1] === 0 && call.args[2] === true);
                        expect(matchingCall).to.not.be.undefined;
                    }

                    // Verify: all manual limit timers were cancelled
                    expect(manualLimitTimers.size).to.equal(0);

                    // Verify: clearTimeout was called for each guard's timer
                    expect(adapter.clearTimeout.callCount).to.equal(guards.length);

                    // Verify: WriteProductionLimit(deactivate) was called for each connected guard
                    expect(callUnaryFn.callCount).to.equal(guards.length);
                    for (let i = 0; i < guards.length; i++) {
                        const call = callUnaryFn.getCall(i);
                        expect(call.args[1]).to.equal('WriteProductionLimit');
                        expect(call.args[2].limit.is_active).to.equal(false);
                        expect(call.args[2].limit.value).to.equal(0);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('resets manual limits even when some guards are disconnected', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 8 }),
                fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
                async (manualLimits, connectionStates) => {
                    // Ensure arrays are same length by using min length
                    const len = Math.min(manualLimits.length, connectionStates.length);
                    const limits = manualLimits.slice(0, len);
                    const connections = connectionStates.slice(0, len);

                    const adapter = createMockAdapter();

                    const guards = limits.map((limit, idx) => ({
                        name: `Guard_${idx}`,
                        basePath: `LPP.EnergyGuards.Guard_${idx}`,
                        ski: `ski-${idx}`,
                        egLpcClient: { close: sinon.stub() },
                        isConnected: () => connections[idx],
                        manualLimit: limit,
                    }));

                    const manualLimitTimers = new Map();
                    for (const guard of guards) {
                        manualLimitTimers.set(guard.name, 42);
                    }

                    const callUnaryFn = sinon.stub().resolves({});

                    await resetManualLimits(guards, adapter, manualLimitTimers, callUnaryFn);

                    // ALL guards should have manualLimit reset to 0, regardless of connection state
                    for (const guard of guards) {
                        const expectedPath = `${guard.basePath}.manualLimit`;
                        const matchingCall = adapter.setStateAsync
                            .getCalls()
                            .find(call => call.args[0] === expectedPath && call.args[1] === 0 && call.args[2] === true);
                        expect(matchingCall).to.not.be.undefined;
                    }

                    // Only connected guards should have WriteProductionLimit called
                    const connectedCount = connections.filter(c => c).length;
                    expect(callUnaryFn.callCount).to.equal(connectedCount);

                    // All timers should be cleared
                    expect(manualLimitTimers.size).to.equal(0);
                },
            ),
            { numRuns: 100 },
        );
    });
});

describe('Feature: add-lpp-use-case, Property 6: Duplicate SKI Filtering', () => {
    /**
     * Validates: Requirements 8.5
     *
     * For any list of EEBUS-type LPP energy guard configurations containing duplicate SKI values,
     * the adapter SHALL register use cases only for the first occurrence of each unique SKI
     * and skip all subsequent duplicates.
     */

    const guardConfigArb = fc.record({
        name: fc.string(),
        type: fc.constant('eebus'),
        ski: fc.constantFrom('A', 'B', 'C', 'AB', 'BC', 'CD', 'DE', 'ABC', 'BCD', 'CDE'),
        brand: fc.string(),
    });

    const guardConfigsArb = fc.array(guardConfigArb, { minLength: 1, maxLength: 10 });

    it('result contains only first occurrence of each unique SKI', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(guardConfigsArb, configs => {
                const result = filterDuplicateSkis(configs);

                // For each unique SKI in the result, it should be the first occurrence from the input
                for (const entry of result) {
                    const firstInInput = configs.find(c => c.ski === entry.ski);
                    expect(entry).to.equal(firstInInput);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('result SKIs are all unique', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(guardConfigsArb, configs => {
                const result = filterDuplicateSkis(configs);

                const skis = result.map(r => r.ski);
                const uniqueSkis = new Set(skis);
                expect(uniqueSkis.size).to.equal(skis.length);
            }),
            { numRuns: 100 },
        );
    });

    it('result is a subset of original array preserving order', function () {
        this.timeout(30000);

        fc.assert(
            fc.property(guardConfigsArb, configs => {
                const result = filterDuplicateSkis(configs);

                // Every item in result must appear in configs
                for (const entry of result) {
                    expect(configs).to.include(entry);
                }

                // Order is preserved: indices in the original array must be strictly increasing
                let lastIndex = -1;
                for (const entry of result) {
                    const idx = configs.indexOf(entry);
                    expect(idx).to.be.greaterThan(lastIndex);
                    lastIndex = idx;
                }
            }),
            { numRuns: 100 },
        );
    });
});
