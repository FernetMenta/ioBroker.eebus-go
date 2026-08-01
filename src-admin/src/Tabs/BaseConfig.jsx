import React, { Component } from 'react';
import PropTypes from 'prop-types';

import { TextField, Button, Box, Checkbox, FormControlLabel } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { I18n, Logo } from '@iobroker/gui-components';
import { QRCodeSVG } from 'qrcode.react';

const styles = {
    tab: {
        width: '100%',
        minHeight: '100%',
    },
    input: {
        minWidth: 400,
        marginRight: 2,
        marginBottom: 2,
    },
    column: {
        display: 'inline-block',
        verticalAlign: 'top',
        marginRight: 20,
    },
    columnSettings: {
        width: 'calc(100% - 10px)',
    },
};

/**
 * Class for handling basic settings like connection parameters
 */
class Options extends Component {
    /**
     * @param {object} props - properties set when the component gets created
     */
    constructor(props) {
        super(props);

        this.state = {
            inAction: false,
            isInstanceAlive: false,
            rowSelectionModel: { type: 'include', ids: new Set() },
            discoveredDevices: {},
            ski: '',
        };

        this.aliveId = `system.adapter.${this.props.adapterName}.${this.props.instance}.alive`;
        this.discoveredDevicesId = `${this.props.adapterName}.${this.props.instance}.info.discoveredDevices`;
        this.skiId = `${this.props.adapterName}.${this.props.instance}.info.ski`;

        this.columns = [
            { field: 'remoteSki', headerName: 'SKI', minWidth: 350, flex: 2 },
            { field: 'brand', headerName: I18n.t('Brand'), minWidth: 100, flex: 1 },
            { field: 'model', headerName: I18n.t('Model'), minWidth: 100, flex: 1 },
            { field: 'deviceType', headerName: I18n.t('Type'), minWidth: 100, flex: 1 },
            { field: 'isTrusted', headerName: I18n.t('Trusted'), minWidth: 80, type: 'boolean' },
        ];
    }

    /**
     * Called by React when component was mounted
     */
    componentDidMount() {
        this.props.socket.getState(this.aliveId).then(state => {
            this.setState({ isInstanceAlive: state && state.val });
            this.props.socket.subscribeState(this.aliveId, this.onAliveChanged);
        });
        // Subscribe to discoveredDevices state
        this.props.socket.getState(this.discoveredDevicesId).then(state => {
            if (state && state.val) {
                try {
                    this.setState({ discoveredDevices: JSON.parse(state.val) });
                } catch {
                    /* ignore parse errors */
                }
            }
        });
        this.props.socket.subscribeState(this.discoveredDevicesId, this.onDiscoveredDevicesChanged);

        // Subscribe to local SKI state
        this.props.socket.getState(this.skiId).then(state => {
            if (state && state.val) {
                this.setState({ ski: state.val });
            }
        });
        this.props.socket.subscribeState(this.skiId, this.onSkiChanged);
    }

    /**
     * Called by React before component will unmount.
     */
    componentWillUnmount() {
        this.props.socket.unsubscribeState(this.aliveId, this.onAliveChanged);
        this.props.socket.unsubscribeState(this.discoveredDevicesId, this.onDiscoveredDevicesChanged);
        this.props.socket.unsubscribeState(this.skiId, this.onSkiChanged);
    }

    onAliveChanged = (id, state) => {
        if (id === this.aliveId) {
            this.setState({ isInstanceAlive: state && state.val });
        }
    };

    onDiscoveredDevicesChanged = (id, state) => {
        if (id === this.discoveredDevicesId && state && state.val) {
            try {
                this.setState({ discoveredDevices: JSON.parse(state.val) });
            } catch {
                /* ignore parse errors */
            }
        }
    };

    onSkiChanged = (id, state) => {
        if (id === this.skiId && state) {
            this.setState({ ski: state.val || '' });
        }
    };

    /**
     * Get discovered devices as array for DataGrid rows.
     *
     * @returns {Array} rows
     */
    getDiscoveredDeviceRows() {
        const devices = this.state.discoveredDevices || {};
        return Object.values(devices).map(d => ({
            id: d.remoteSki,
            remoteSki: d.remoteSki,
            brand: d.brand || '',
            model: d.model || '',
            deviceType: d.deviceType || '',
            isTrusted: d.isTrusted || false,
        }));
    }

    /**
     * Copy the selected device SKI to controlboxSki config.
     */
    handleCopyToControlboxSki = () => {
        const selected = this.state.rowSelectionModel;
        if (selected.ids.size > 0) {
            this.props.onChange('controlboxSki', [...selected.ids][0]);
        }
    };

    /**
     * Format a hex SKI string into space-separated 4-char groups.
     *
     * @param {string} ski - Raw hex SKI (e.g. "2bf3f7efc244f1bdd5a861a2f07c3243ab0468be")
     * @returns {string} Formatted SKI (e.g. "2bf3 f7ef c244 ...")
     */
    formatSki(ski) {
        const clean = ski.replace(/[\s-]/g, '').toLowerCase();
        return clean.replace(/(.{4})/g, '$1 ').trim();
    }

    /**
     * Build SHIP connection string for QR code.
     *
     * @returns {string} The SHIP URI or empty string if SKI not available
     */
    getShipConnectionString() {
        const { ski } = this.state;
        if (!ski) {
            return '';
        }
        const formattedSki = this.formatSki(ski);
        return `SHIP;SKI:${formattedSki};ID:i:12345_u:123abc456def;END`;
    }

    /**
     * Renders the component
     */
    render() {
        const rows = this.getDiscoveredDeviceRows();
        const shipString = this.getShipConnectionString();

        return (
            <form style={{ ...styles.tab }}>
                <Logo
                    instance={this.props.instance}
                    common={this.props.common}
                    native={this.props.native}
                    onError={text => this.setState({ errorText: text })}
                    onLoad={this.props.onLoad}
                />
                <div style={{ ...styles.column, ...styles.columnSettings, position: 'relative' }}>
                    <TextField
                        style={{ ...styles.input }}
                        variant="standard"
                        label={I18n.t('gRPC Endpoint')}
                        value={this.props.native.grpcEndpoint}
                        type="text"
                        onChange={e => this.props.onChange('grpcEndpoint', e.target.value)}
                        margin="normal"
                    />
                    <br />
                    <TextField
                        style={{ ...styles.input }}
                        variant="standard"
                        label={I18n.t('Service Port')}
                        value={this.props.native.servicePort}
                        type="number"
                        onChange={e => this.props.onChange('servicePort', parseInt(e.target.value, 10) || 0)}
                        margin="normal"
                    />
                    <br />
                    <TextField
                        style={{ ...styles.input }}
                        variant="standard"
                        label={I18n.t('Serial Number')}
                        value={this.props.native.serialNumber}
                        type="text"
                        onChange={e => this.props.onChange('serialNumber', e.target.value)}
                        margin="normal"
                    />
                    <br />
                    <TextField
                        style={{ ...styles.input }}
                        variant="standard"
                        label={I18n.t('Heartbeat Timeout (seconds)')}
                        value={this.props.native.heartbeatTimeoutSeconds}
                        type="number"
                        onChange={e =>
                            this.props.onChange('heartbeatTimeoutSeconds', parseInt(e.target.value, 10) || 30)
                        }
                        margin="normal"
                    />
                    <br />
                    <TextField
                        style={{ ...styles.input }}
                        variant="standard"
                        label={I18n.t('ControlBox SKI')}
                        value={this.props.native.controlboxSki}
                        type="text"
                        disabled
                        margin="normal"
                    />
                    <br />
                    <br />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                        <FormControlLabel
                            sx={{ minWidth: 420 }}
                            control={
                                <Checkbox
                                    checked={this.props.native.lpcEnabled !== false}
                                    onChange={e => this.props.onChange('lpcEnabled', e.target.checked)}
                                />
                            }
                            label={I18n.t('Enable LPC (Limitation of Power Consumption)')}
                        />
                        <TextField
                            variant="standard"
                            label={I18n.t('Contractual Consumption Nominal Max (W)')}
                            value={this.props.native.contractualConsumptionNominalMax}
                            type="number"
                            onChange={e =>
                                this.props.onChange(
                                    'contractualConsumptionNominalMax',
                                    parseInt(e.target.value, 10) || 0,
                                )
                            }
                            margin="normal"
                            sx={{ minWidth: 300 }}
                        />
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                        <FormControlLabel
                            sx={{ minWidth: 420 }}
                            control={
                                <Checkbox
                                    checked={!!this.props.native.lppEnabled}
                                    onChange={e => this.props.onChange('lppEnabled', e.target.checked)}
                                />
                            }
                            label={I18n.t('Enable LPP (Limitation of Power Production)')}
                        />
                        {!!this.props.native.lppEnabled && (
                            <TextField
                                variant="standard"
                                label={I18n.t('Contractual Production Nominal Max (W)')}
                                value={this.props.native.contractualProductionNominalMax ?? ''}
                                type="number"
                                inputProps={{ min: 0, max: 999999 }}
                                onChange={e => {
                                    const parsed = parseInt(e.target.value, 10);
                                    this.props.onChange(
                                        'contractualProductionNominalMax',
                                        Number.isFinite(parsed) ? parsed : 0,
                                    );
                                }}
                                margin="normal"
                                sx={{ minWidth: 300 }}
                            />
                        )}
                    </Box>
                    <br />
                    <h3>{I18n.t('Discovered Devices')}</h3>
                    <Box sx={{ height: 300, width: '100%' }}>
                        <DataGrid
                            rows={rows}
                            columns={this.columns}
                            rowHeight={36}
                            rowSelectionModel={this.state.rowSelectionModel}
                            onRowSelectionModelChange={newSelection =>
                                this.setState({ rowSelectionModel: newSelection })
                            }
                        />
                    </Box>
                    <Button
                        variant="contained"
                        color="primary"
                        disabled={this.state.rowSelectionModel.ids.size === 0}
                        onClick={this.handleCopyToControlboxSki}
                        style={{ marginTop: 8 }}
                    >
                        {I18n.t('Use selected SKI as ControlBox SKI')}
                    </Button>
                    {shipString && (
                        <div style={{ position: 'absolute', top: 0, right: 0, textAlign: 'center' }}>
                            <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>EEBUS SKI</div>
                            <QRCodeSVG
                                value={shipString}
                                size={160}
                            />
                            <div
                                style={{
                                    fontSize: 11,
                                    marginTop: 4,
                                    color: '#666',
                                    maxWidth: 160,
                                    wordBreak: 'break-all',
                                }}
                            >
                                {this.state.ski}
                            </div>
                        </div>
                    )}
                </div>
            </form>
        );
    }
}

Options.propTypes = {
    common: PropTypes.object.isRequired,
    native: PropTypes.object.isRequired,
    instance: PropTypes.number.isRequired,
    adapterName: PropTypes.string.isRequired,
    onError: PropTypes.func,
    onLoad: PropTypes.func,
    onChange: PropTypes.func,
    changed: PropTypes.bool,
    socket: PropTypes.object.isRequired,
};

export default Options;
