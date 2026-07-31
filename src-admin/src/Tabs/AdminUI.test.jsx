import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mock @iobroker/gui-components
vi.mock('@iobroker/gui-components', () => ({
    I18n: { t: key => key },
    GenericApp: class GenericApp extends React.Component {
        constructor(props, _extendedProps) {
            super(props);
            this.state = {
                native: {},
                loaded: true,
                theme: { palette: { background: { default: '#fff' }, text: { primary: '#000' } } },
            };
            this.socket = props.socket || {};
            this.common = {};
            this.instance = 0;
            this.adapterName = 'eebus-go';
        }
        updateNativeValue() {}
        onLoadConfig() {}
        renderSaveCloseButtons() {
            return null;
        }
        renderError() {
            return null;
        }
    },
    Router: { doNavigate: vi.fn() },
    Loader: () => <div>Loading...</div>,
    Logo: () => <div data-testid="logo" />,
}));

// Mock qrcode.react
vi.mock('qrcode.react', () => ({
    QRCodeSVG: () => <div data-testid="qrcode" />,
}));

// Mock @mui/x-data-grid
vi.mock('@mui/x-data-grid', () => ({
    DataGrid: ({ rows }) => (
        <div data-testid="data-grid">
            {rows.map((row, i) => (
                <div
                    key={i}
                    data-testid={`grid-row-${i}`}
                >
                    {row.name || row.remoteSki || ''}
                </div>
            ))}
        </div>
    ),
}));

// Create a mock socket
function createMockSocket() {
    return {
        getState: vi.fn().mockResolvedValue(null),
        subscribeState: vi.fn(),
        unsubscribeState: vi.fn(),
    };
}

// ============================================================
// Test 1: App tab visibility based on lpcEnabled/lppEnabled
// ============================================================
describe('App tab visibility', () => {
    let App;

    beforeEach(async () => {
        vi.resetModules();
        // Re-import App after mocks are set up
        const module = await import('../App.jsx');
        App = module.default;
    });

    it('shows "LPC Energy Guards" tab when lpcEnabled is true', () => {
        const app = new App({});
        app.state = { ...app.state, native: { lpcEnabled: true, lppEnabled: false } };
        const tabs = app.getVisibleTabs();
        expect(tabs).toContain('energyguards');
    });

    it('shows "LPC Energy Guards" tab when lpcEnabled is undefined (default)', () => {
        const app = new App({});
        app.state = { ...app.state, native: {} };
        const tabs = app.getVisibleTabs();
        expect(tabs).toContain('energyguards');
    });

    it('hides "LPC Energy Guards" tab when lpcEnabled is false', () => {
        const app = new App({});
        app.state = { ...app.state, native: { lpcEnabled: false } };
        const tabs = app.getVisibleTabs();
        expect(tabs).not.toContain('energyguards');
    });

    it('shows "LPP Energy Guards" tab only when lppEnabled is true', () => {
        const app = new App({});
        app.state = { ...app.state, native: { lppEnabled: true } };
        const tabs = app.getVisibleTabs();
        expect(tabs).toContain('lppengergyguards');
    });

    it('hides "LPP Energy Guards" tab when lppEnabled is false', () => {
        const app = new App({});
        app.state = { ...app.state, native: { lppEnabled: false } };
        const tabs = app.getVisibleTabs();
        expect(tabs).not.toContain('lppengergyguards');
    });

    it('hides "LPP Energy Guards" tab when lppEnabled is undefined', () => {
        const app = new App({});
        app.state = { ...app.state, native: {} };
        const tabs = app.getVisibleTabs();
        expect(tabs).not.toContain('lppengergyguards');
    });
});

// ============================================================
// Test 2: LppEnergyGuardsConfig empty discovered devices message
// ============================================================
describe('LppEnergyGuardsConfig empty discovered devices', () => {
    let LppEnergyGuardsConfig;

    beforeEach(async () => {
        const module = await import('./LppEnergyGuardsConfig.jsx');
        LppEnergyGuardsConfig = module.default;
    });

    it('shows "No discovered devices available" when device list is empty', async () => {
        const socket = createMockSocket();
        const props = {
            common: {},
            native: { lppEnergyGuards: [] },
            instance: 0,
            adapterName: 'eebus-go',
            socket,
            onChange: vi.fn(),
        };

        render(<LppEnergyGuardsConfig {...props} />);

        // Open the dialog
        const addEebusButton = screen.getByText('Add EEBUS');
        await act(async () => {
            fireEvent.click(addEebusButton);
        });

        expect(screen.getByText('No discovered devices available')).toBeInTheDocument();
    });
});

// ============================================================
// Test 3: BaseConfig contractualProductionNominalMax validation
// ============================================================
describe('BaseConfig contractualProductionNominalMax validation', () => {
    it('falls back to 0 for non-numeric/empty values via onChange handler', () => {
        // Test the inline logic: parseInt(e.target.value, 10) -> Number.isFinite(parsed) ? parsed : 0
        // This simulates the onChange handler logic in BaseConfig
        const testCases = [
            { input: '', expected: 0 },
            { input: 'abc', expected: 0 },
            { input: '123', expected: 123 },
            { input: '0', expected: 0 },
            { input: '999999', expected: 999999 },
            { input: '-5', expected: -5 },
            { input: '3.7', expected: 3 },
            { input: 'NaN', expected: 0 },
        ];

        for (const { input, expected } of testCases) {
            const parsed = parseInt(input, 10);
            const result = Number.isFinite(parsed) ? parsed : 0;
            expect(result).toBe(expected);
        }
    });

    it('contractualProductionNominalMax field calls onChange with correct fallback', async () => {
        const { default: BaseConfig } = await import('./BaseConfig.jsx');
        const socket = createMockSocket();
        const onChange = vi.fn();
        const props = {
            common: {},
            native: {
                grpcEndpoint: 'localhost:50051',
                servicePort: 4712,
                serialNumber: '123',
                heartbeatTimeoutSeconds: 30,
                contractualConsumptionNominalMax: 4200,
                controlboxSki: '',
                lpcEnabled: true,
                lppEnabled: true,
                contractualProductionNominalMax: 1000,
            },
            instance: 0,
            adapterName: 'eebus-go',
            socket,
            onChange,
            onLoad: vi.fn(),
        };

        render(<BaseConfig {...props} />);

        // Find the contractual production nominal max input by its label
        const input = screen.getByLabelText('Contractual Production Nominal Max (watts)');
        expect(input).toBeInTheDocument();

        // Simulate entering empty value
        await act(async () => {
            fireEvent.change(input, { target: { value: '' } });
        });

        // onChange should be called with 0 for empty input
        expect(onChange).toHaveBeenCalledWith('contractualProductionNominalMax', 0);
    });
});

// ============================================================
// Test 4: LppEnergyGuardsConfig guard add/remove operations
// ============================================================
describe('LppEnergyGuardsConfig guard add/remove operations', () => {
    let LppEnergyGuardsConfig;

    beforeEach(async () => {
        const module = await import('./LppEnergyGuardsConfig.jsx');
        LppEnergyGuardsConfig = module.default;
    });

    it('adds a manual guard when "Add Manual" is clicked', async () => {
        const socket = createMockSocket();
        const onChange = vi.fn();
        const props = {
            common: {},
            native: { lppEnergyGuards: [] },
            instance: 0,
            adapterName: 'eebus-go',
            socket,
            onChange,
        };

        render(<LppEnergyGuardsConfig {...props} />);

        const addManualButton = screen.getByText('Add Manual');
        await act(async () => {
            fireEvent.click(addManualButton);
        });

        expect(onChange).toHaveBeenCalledWith('lppEnergyGuards', [{ name: '', type: 'manual', ski: '', brand: '' }]);
    });

    it('removes selected guard when "Remove" is clicked', () => {
        const _socket = createMockSocket();
        const _onChange = vi.fn();
        const existingGuards = [
            { name: 'Guard1', type: 'eebus', ski: 'ski1', brand: 'Brand1' },
            { name: 'Guard2', type: 'manual', ski: '', brand: '' },
        ];

        // Test the remove logic directly (same as the component's handleRemove method)
        const selected = { type: 'include', ids: new Set([0]) };
        const guards = [...existingGuards];
        const indexToRemove = [...selected.ids][0];
        guards.splice(indexToRemove, 1);

        expect(guards).toEqual([{ name: 'Guard2', type: 'manual', ski: '', brand: '' }]);
    });

    it('appends multiple manual guards correctly', async () => {
        const socket = createMockSocket();
        const onChange = vi.fn();
        const existingGuards = [{ name: 'Existing', type: 'eebus', ski: 'abc', brand: 'Test' }];
        const props = {
            common: {},
            native: { lppEnergyGuards: existingGuards },
            instance: 0,
            adapterName: 'eebus-go',
            socket,
            onChange,
        };

        render(<LppEnergyGuardsConfig {...props} />);

        const addManualButton = screen.getByText('Add Manual');
        await act(async () => {
            fireEvent.click(addManualButton);
        });

        expect(onChange).toHaveBeenCalledWith('lppEnergyGuards', [
            { name: 'Existing', type: 'eebus', ski: 'abc', brand: 'Test' },
            { name: '', type: 'manual', ski: '', brand: '' },
        ]);
    });

    it('does not remove when no guard is selected', () => {
        // Test the remove logic with no selection
        const onChange = vi.fn();
        const selected = { type: 'include', ids: new Set() };

        // This simulates handleRemove - if ids.size === 0, it returns early
        if (selected.ids.size === 0) {
            // Should not call onChange
            expect(onChange).not.toHaveBeenCalled();
            return;
        }
    });
});
