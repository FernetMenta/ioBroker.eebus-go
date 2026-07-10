import React, { Component } from 'react';
import PropTypes from 'prop-types';

import { TextField, Button, Box } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { I18n, Logo } from '@iobroker/adapter-react-v5';

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
            rowSelectionModel: [],
            discoveredDevices: props.native.discoveredDevices || {},
        };

        this.aliveId = `system.adapter.${this.props.adapterName}.${this.props.instance}.alive`;
        this.adapterObjectId = `system.adapter.${this.props.adapterName}.${this.props.instance}`;

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
        // Subscribe to adapter object changes to detect discoveredDevices updates
        this.props.socket.subscribeObject(this.adapterObjectId, this.onObjectChanged);
    }

    /**
     * Called by React before component will unmount.
     */
    componentWillUnmount() {
        this.props.socket.unsubscribeState(this.aliveId, this.onAliveChanged);
        this.props.socket.unsubscribeObject(this.adapterObjectId, this.onObjectChanged);
    }

    onAliveChanged = (id, state) => {
        if (id === this.aliveId) {
            this.setState({ isInstanceAlive: state && state.val });
        }
    };

    onObjectChanged = (id, obj) => {
        if (id === this.adapterObjectId && obj && obj.native && obj.native.discoveredDevices) {
            this.setState({ discoveredDevices: obj.native.discoveredDevices });
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
        if (selected.length > 0) {
            this.props.onChange('controlboxSki', selected[0]);
        }
    };

    /**
     * Renders the component
     */
    render() {
        const rows = this.getDiscoveredDeviceRows();

        return (
            <form style={{ ...styles.tab }}>
                <Logo
                    instance={this.props.instance}
                    common={this.props.common}
                    native={this.props.native}
                    onError={text => this.setState({ errorText: text })}
                    onLoad={this.props.onLoad}
                />
                <div style={{ ...styles.column, ...styles.columnSettings }}>
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
                        label={I18n.t('Min Approval Limit (W)')}
                        value={this.props.native.minApprovalLimit}
                        type="number"
                        onChange={e => this.props.onChange('minApprovalLimit', parseInt(e.target.value, 10) || 0)}
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
                    <h3>{I18n.t('Discovered Devices')}</h3>
                    <Box sx={{ height: 400, width: '100%' }}>
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
                        disabled={this.state.rowSelectionModel.length === 0}
                        onClick={this.handleCopyToControlboxSki}
                        style={{ marginTop: 8 }}
                    >
                        {I18n.t('Use selected SKI as ControlBox SKI')}
                    </Button>
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
