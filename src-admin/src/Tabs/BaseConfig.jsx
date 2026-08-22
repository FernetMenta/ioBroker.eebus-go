import React, { Component } from 'react';
import PropTypes from 'prop-types';

import {
    TextField,
    Button,
    Box,
    Checkbox,
    FormControlLabel,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { I18n, Logo } from '@iobroker/gui-components';
import { QRCodeSVG } from 'qrcode.react';

const styles = {
    tab: { width: '100%', minHeight: '100%' },
    column: { display: 'inline-block', verticalAlign: 'top', marginRight: 20 },
    columnSettings: { width: 'calc(100% - 10px)' },
};

class Options extends Component {
    constructor(props) {
        super(props);
        this.state = {
            inAction: false,
            isInstanceAlive: false,
            dockerInstalled: false,
            rowSelectionModel: { type: 'include', ids: new Set() },
            discoveredDevices: {},
            ski: '',
        };
        this.aliveId = `system.adapter.${this.props.adapterName}.${this.props.instance}.alive`;
        this.dockerInstalledId = `${this.props.adapterName}.${this.props.instance}.info.dockerInstalled`;
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

    componentDidMount() {
        this.props.socket.getState(this.aliveId).then(state => {
            this.setState({ isInstanceAlive: state && state.val });
            this.props.socket.subscribeState(this.aliveId, this.onAliveChanged);
        });
        this.props.socket.getState(this.dockerInstalledId).then(state => {
            const installed = !!(state && state.val);
            this.setState({ dockerInstalled: installed });
            if (!installed && this.props.native.dockerEnabled) {
                this.props.onChange('dockerEnabled', false);
            }
        });
        this.props.socket.subscribeState(this.dockerInstalledId, this.onDockerInstalledChanged);
        this.props.socket.getState(this.discoveredDevicesId).then(state => {
            if (state && state.val) {
                try {
                    this.setState({ discoveredDevices: JSON.parse(state.val) });
                } catch {
                    /* ignore */
                }
            }
        });
        this.props.socket.subscribeState(this.discoveredDevicesId, this.onDiscoveredDevicesChanged);
        this.props.socket.getState(this.skiId).then(state => {
            if (state && state.val) {
                this.setState({ ski: state.val });
            }
        });
        this.props.socket.subscribeState(this.skiId, this.onSkiChanged);
    }

    componentWillUnmount() {
        this.props.socket.unsubscribeState(this.aliveId, this.onAliveChanged);
        this.props.socket.unsubscribeState(this.dockerInstalledId, this.onDockerInstalledChanged);
        this.props.socket.unsubscribeState(this.discoveredDevicesId, this.onDiscoveredDevicesChanged);
        this.props.socket.unsubscribeState(this.skiId, this.onSkiChanged);
    }

    onAliveChanged = (id, state) => {
        if (id === this.aliveId) {
            this.setState({ isInstanceAlive: state && state.val });
        }
    };

    onDockerInstalledChanged = (id, state) => {
        if (id === this.dockerInstalledId) {
            const installed = !!(state && state.val);
            this.setState({ dockerInstalled: installed });
            if (!installed && this.props.native.dockerEnabled) {
                this.props.onChange('dockerEnabled', false);
            }
        }
    };

    onDiscoveredDevicesChanged = (id, state) => {
        if (id === this.discoveredDevicesId && state) {
            if (!state.val) {
                this.setState({ discoveredDevices: {} });
            } else {
                try {
                    this.setState({ discoveredDevices: JSON.parse(state.val) });
                } catch {
                    this.setState({ discoveredDevices: {} });
                }
            }
        }
    };

    onSkiChanged = (id, state) => {
        if (id === this.skiId && state) {
            this.setState({ ski: state.val || '' });
        }
    };

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

    handleCopyToControlboxSki = () => {
        const selected = this.state.rowSelectionModel;
        if (selected.ids.size > 0) {
            this.props.onChange('controlboxSki', [...selected.ids][0]);
        }
    };

    formatSki(ski) {
        const clean = ski.replace(/[\s-]/g, '').toLowerCase();
        return clean.replace(/(.{4})/g, '$1 ').trim();
    }

    getShipConnectionString() {
        const { ski } = this.state;
        if (!ski) return '';
        const formattedSki = this.formatSki(ski);
        return `SHIP;SKI:${formattedSki};ID:i:12345_u:123abc456def;END`;
    }

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
                    {this.state.dockerInstalled && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
                            <FormControlLabel
                                sx={{ minWidth: { xs: 'auto', md: 420 } }}
                                control={
                                    <Checkbox
                                        checked={!!this.props.native.dockerEnabled}
                                        onChange={e => this.props.onChange('dockerEnabled', e.target.checked)}
                                    />
                                }
                                label={I18n.t('Enable Docker Container')}
                            />
                            <FormControl
                                variant="standard"
                                sx={{ minWidth: { xs: 'auto', md: 300 } }}
                            >
                                <InputLabel>{I18n.t('Docker Log Level')}</InputLabel>
                                <Select
                                    value={this.props.native.dockerLogLevel || 'info'}
                                    onChange={e => this.props.onChange('dockerLogLevel', e.target.value)}
                                    disabled={!this.props.native.dockerEnabled}
                                >
                                    <MenuItem value="trace">trace</MenuItem>
                                    <MenuItem value="debug">debug</MenuItem>
                                    <MenuItem value="info">info</MenuItem>
                                    <MenuItem value="warn">warn</MenuItem>
                                    <MenuItem value="error">error</MenuItem>
                                </Select>
                            </FormControl>
                        </Box>
                    )}
                    <TextField
                        sx={{ width: { xs: '100%', md: 400 }, mr: { md: 2 }, mb: 2 }}
                        variant="standard"
                        label={I18n.t('gRPC Endpoint')}
                        value={this.props.native.grpcEndpoint}
                        type="text"
                        onChange={e => this.props.onChange('grpcEndpoint', e.target.value)}
                        margin="normal"
                        disabled={!!this.props.native.dockerEnabled}
                    />
                    <br />
                    <TextField
                        sx={{ width: { xs: '100%', md: 400 }, mr: { md: 2 }, mb: 2 }}
                        variant="standard"
                        label={I18n.t('Service Port')}
                        value={this.props.native.servicePort ?? ''}
                        type="number"
                        slotProps={{ htmlInput: { min: 1, max: 65535 } }}
                        onChange={e => {
                            const val = e.target.value;
                            this.props.onChange('servicePort', val === '' ? '' : parseInt(val, 10));
                        }}
                        onBlur={e => {
                            let value = parseInt(e.target.value, 10);
                            if (Number.isNaN(value) || value < 1) value = 4712;
                            if (value > 65535) value = 65535;
                            this.props.onChange('servicePort', value);
                        }}
                        margin="normal"
                    />
                    <br />
                    <TextField
                        sx={{ width: { xs: '100%', md: 400 }, mr: { md: 2 }, mb: 2 }}
                        variant="standard"
                        label={I18n.t('Serial Number')}
                        value={this.props.native.serialNumber}
                        type="text"
                        onChange={e => this.props.onChange('serialNumber', e.target.value)}
                        margin="normal"
                    />
                    <br />
                    <TextField
                        sx={{ width: { xs: '100%', md: 400 }, mr: { md: 2 }, mb: 2 }}
                        variant="standard"
                        label={I18n.t('Heartbeat Timeout (seconds)')}
                        value={this.props.native.heartbeatTimeoutSeconds ?? ''}
                        type="number"
                        slotProps={{ htmlInput: { min: 5, max: 300 } }}
                        onChange={e => {
                            const val = e.target.value;
                            this.props.onChange('heartbeatTimeoutSeconds', val === '' ? '' : parseInt(val, 10));
                        }}
                        onBlur={e => {
                            let value = parseInt(e.target.value, 10);
                            if (Number.isNaN(value) || value < 5) value = 30;
                            if (value > 300) value = 300;
                            this.props.onChange('heartbeatTimeoutSeconds', value);
                        }}
                        margin="normal"
                    />
                    <br />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                        <TextField
                            sx={{ minWidth: { xs: 'auto', md: 420 } }}
                            variant="standard"
                            label={I18n.t('ControlBox SKI')}
                            value={this.props.native.controlboxSki || ''}
                            type="text"
                            disabled
                            margin="normal"
                        />
                        <Button
                            variant="outlined"
                            size="small"
                            disabled={!this.props.native.controlboxSki}
                            onClick={() => this.props.onChange('controlboxSki', '')}
                            sx={{ minWidth: { xs: 'auto', md: 300 } }}
                        >
                            {I18n.t('Clear ControlBox SKI')}
                        </Button>
                    </Box>
                    <br />
                    <Box
                        sx={{
                            display: 'flex',
                            flexDirection: { xs: 'column', md: 'row' },
                            alignItems: { md: 'center' },
                            gap: { xs: 0, md: 2 },
                            mb: 1,
                            flexWrap: 'wrap',
                        }}
                    >
                        <FormControlLabel
                            sx={{ minWidth: { md: 420 } }}
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
                            value={this.props.native.contractualConsumptionNominalMax ?? ''}
                            type="number"
                            slotProps={{ htmlInput: { min: 0, max: 999999 } }}
                            onChange={e => {
                                const val = e.target.value;
                                this.props.onChange(
                                    'contractualConsumptionNominalMax',
                                    val === '' ? '' : parseInt(val, 10),
                                );
                            }}
                            onBlur={e => {
                                let value = parseInt(e.target.value, 10);
                                if (Number.isNaN(value) || value < 0) value = 0;
                                if (value > 999999) value = 999999;
                                this.props.onChange('contractualConsumptionNominalMax', value);
                            }}
                            margin="normal"
                            sx={{ width: { xs: '100%', md: 300 } }}
                        />
                    </Box>
                    <Box
                        sx={{
                            display: 'flex',
                            flexDirection: { xs: 'column', md: 'row' },
                            alignItems: { md: 'center' },
                            gap: { xs: 0, md: 2 },
                            mb: 1,
                            flexWrap: 'wrap',
                        }}
                    >
                        <FormControlLabel
                            sx={{ minWidth: { md: 420 } }}
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
                                slotProps={{ htmlInput: { min: 0, max: 999999 } }}
                                onChange={e => {
                                    const val = e.target.value;
                                    this.props.onChange(
                                        'contractualProductionNominalMax',
                                        val === '' ? '' : parseInt(val, 10),
                                    );
                                }}
                                onBlur={e => {
                                    let value = parseInt(e.target.value, 10);
                                    if (Number.isNaN(value) || value < 0) value = 0;
                                    if (value > 999999) value = 999999;
                                    this.props.onChange('contractualProductionNominalMax', value);
                                }}
                                margin="normal"
                                sx={{ width: { xs: '100%', md: 300 } }}
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
                        <Box
                            sx={{
                                position: { xs: 'static', md: 'absolute' },
                                top: { md: 0 },
                                right: { md: 0 },
                                textAlign: 'center',
                                mb: { xs: 2, md: 0 },
                            }}
                        >
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
                        </Box>
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
