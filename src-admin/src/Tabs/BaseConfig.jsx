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
    Alert,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Typography,
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { ExpandMore } from '@mui/icons-material';
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
            dockerApiError: '',
            dockerTestResult: '',
            dockerExpanded: false,
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

    /**
     * Parse a Docker API URL (http/https) into the connection struct the plugin expects.
     * Empty input means "auto-detect the local endpoint". Mirrors main.js parseDockerApiUrl.
     * Returns { struct, error }.
     */
    parseDockerApiUrl(url) {
        if (!url || !url.trim()) {
            return { struct: '', error: '' };
        }
        const trimmed = url.trim();
        let parsed;
        try {
            parsed = new URL(trimmed);
        } catch {
            return { struct: null, error: I18n.t('Invalid URL') };
        }
        const scheme = parsed.protocol.replace(/:$/, '');
        // TODO(unix-socket): accept scheme === 'unix' once plugin-docker supports socketPath.
        if (scheme !== 'http' && scheme !== 'https') {
            return { struct: null, error: I18n.t('Only http:// and https:// are supported') };
        }
        if (!parsed.hostname) {
            return { struct: null, error: I18n.t('Invalid URL') };
        }
        const port = parsed.port ? parseInt(parsed.port, 10) : scheme === 'https' ? 2376 : 2375;
        return {
            struct: {
                host: parsed.hostname,
                port,
                protocol: scheme,
                ca: '',
                cert: '',
                key: '',
            },
            error: '',
        };
    }

    onDockerApiUrlChange = url => {
        // Only persist the human-readable URL on each keystroke. The parsed struct (consumed via
        // ${config.dockerApi}) is written on blur / successful "Test & Enable", not here — writing
        // an object into native on every keystroke races with the string update and makes the
        // controlled input drop characters.
        this.setState({ dockerApiError: this.parseDockerApiUrl(url).error });
        this.props.onChange('dockerApiUrl', url);
    };

    onDockerApiUrlBlur = () => {
        // Keep native.dockerApi (the struct the plugin reads at startup via ${config.dockerApi})
        // in sync with the URL once the user leaves the field. Done on blur, not per keystroke,
        // to avoid the controlled-input race. Empty/invalid URL -> clear the struct so the plugin
        // auto-detects the local endpoint instead of using a stale value.
        const { struct, error } = this.parseDockerApiUrl(this.props.native.dockerApiUrl || '');
        if (error) {
            return;
        }
        this.props.onChange('dockerApi', struct || '');
    };

    handleTestAndEnable = () => {
        const { struct, error } = this.parseDockerApiUrl(this.props.native.dockerApiUrl || '');
        if (error) {
            this.setState({ dockerApiError: error, dockerTestResult: '' });
            return;
        }
        this.setState({ inAction: true, dockerTestResult: '' });
        this.props.socket
            .sendTo(`${this.props.adapterName}.${this.props.instance}`, 'testDockerApi', {
                url: this.props.native.dockerApiUrl || '',
            })
            .then(result => {
                if (result && result.success) {
                    // Persist the parsed struct and flip the enabled flag only on a successful probe.
                    this.props.onChange('dockerApi', struct);
                    this.props.onChange('dockerEnabled', true);
                    this.setState({
                        dockerTestResult: I18n.t('Docker API reachable — enabled'),
                        dockerApiError: '',
                    });
                } else {
                    this.setState({
                        dockerTestResult: (result && result.error) || I18n.t('Docker API not reachable'),
                    });
                }
            })
            .catch(e => this.setState({ dockerTestResult: e.message || I18n.t('Docker API not reachable') }))
            .finally(() => this.setState({ inAction: false }));
    };

    handleDisableDocker = () => {
        this.props.onChange('dockerEnabled', false);
        this.setState({ dockerTestResult: '' });
    };

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
                    {/* Docker settings — collapsible accordion. Collapsed shows only the title and
                        the (read-only) enabled status; expanded reveals the full Docker config. */}
                    <Accordion
                        expanded={this.state.dockerExpanded}
                        onChange={(_e, expanded) => this.setState({ dockerExpanded: expanded })}
                        sx={{
                            mb: 2,
                            // Cap the width to the right edge of the LPC "Minimum Assured Power"
                            // field below: 420 (checkbox col) + 16 (gap) + 300 + 16 (gap) + 300.
                            maxWidth: { md: 1052 },
                        }}
                    >
                        <AccordionSummary expandIcon={<ExpandMore />}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                                <Typography sx={{ fontWeight: 'bold' }}>{I18n.t('Container')}</Typography>
                                {/* Read-only status: reflects the persisted dockerEnabled flag, not an input.
                                    Stop the click from toggling the accordion so it stays a pure status. */}
                                <FormControlLabel
                                    onClick={e => e.stopPropagation()}
                                    onFocus={e => e.stopPropagation()}
                                    control={
                                        <Checkbox
                                            checked={!!this.props.native.dockerEnabled}
                                            readOnly
                                            disabled
                                        />
                                    }
                                    label={I18n.t('Container enabled')}
                                />
                            </Box>
                        </AccordionSummary>
                        {/* Zero the horizontal padding so the fields inside line up with the
                            LPC/LPP rows that live directly in the parent column (no extra inset). */}
                        <AccordionDetails sx={{ px: 0 }}>
                            {!this.state.isInstanceAlive && (
                                <Alert
                                    severity="info"
                                    sx={{ mb: 1, maxWidth: 600 }}
                                >
                                    {I18n.t('Start the adapter instance to configure and test the Docker API.')}
                                </Alert>
                            )}
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
                                {/* API URL occupies the 420px "checkbox column" width so the Log Level
                                    field lines up with "Contractual Consumption Nominal Max" below. */}
                                <TextField
                                    sx={{ width: { xs: '100%', md: 420 } }}
                                    variant="standard"
                                    label={I18n.t('Docker API URL')}
                                    placeholder="http://127.0.0.1:2375"
                                    helperText={
                                        this.state.dockerApiError || I18n.t('Leave empty to auto-detect local Docker')
                                    }
                                    error={!!this.state.dockerApiError}
                                    value={this.props.native.dockerApiUrl || ''}
                                    type="text"
                                    onChange={e => this.onDockerApiUrlChange(e.target.value)}
                                    onBlur={this.onDockerApiUrlBlur}
                                    margin="normal"
                                />
                                <FormControl
                                    variant="standard"
                                    sx={{ width: { xs: '100%', md: 300 } }}
                                >
                                    <InputLabel>{I18n.t('Log Level')}</InputLabel>
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
                            {/* Buttons below the config row. */}
                            <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                                <Button
                                    variant="contained"
                                    color="primary"
                                    disabled={!this.state.isInstanceAlive || this.state.inAction}
                                    onClick={this.handleTestAndEnable}
                                >
                                    {I18n.t('Test & Enable')}
                                </Button>
                                <Button
                                    variant="outlined"
                                    color="secondary"
                                    disabled={!this.props.native.dockerEnabled || this.state.inAction}
                                    onClick={this.handleDisableDocker}
                                >
                                    {I18n.t('Disable')}
                                </Button>
                            </Box>
                            {this.state.dockerTestResult && (
                                <Alert
                                    severity={this.props.native.dockerEnabled ? 'success' : 'warning'}
                                    sx={{ mb: 1, maxWidth: 600 }}
                                >
                                    {this.state.dockerTestResult}
                                </Alert>
                            )}
                        </AccordionDetails>
                    </Accordion>
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
                        <TextField
                            variant="standard"
                            label={I18n.t('Minimum Assured Power (W)')}
                            value={this.props.native.lpcMinimumAssuredPower ?? ''}
                            type="number"
                            slotProps={{ htmlInput: { min: 0, max: 999999 } }}
                            onChange={e => {
                                const val = e.target.value;
                                this.props.onChange('lpcMinimumAssuredPower', val === '' ? '' : parseInt(val, 10));
                            }}
                            onBlur={e => {
                                let value = parseInt(e.target.value, 10);
                                if (Number.isNaN(value) || value < 0) value = 0;
                                if (value > 999999) value = 999999;
                                this.props.onChange('lpcMinimumAssuredPower', value);
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
