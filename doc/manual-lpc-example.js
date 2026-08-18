/*
 ** Example for a manual LPC guard that controls a wallbox
 ** Failsafe is realized by a Tasmota switch (Shelly 4 Mini) that disabled the wallbox
 ** if it doesn't receive heartbeats
 */

const axios = require('axios');
const getenv = require('getenv');

const KEBA_CONNECTED_STR = 'kecontact.0.info.connection';
const KEBA_MAX_GRID_POWER_STR = 'kecontact.0.automatic.maxGridPower';
const KEBA_ENABLE_USER_STR = 'kecontact.0.enableUser';
const KEBA_ENABLE_SYS_STR = 'kecontact.0.enableSys';
const KEBA_X1_STR = 'kecontact.0.input';
const EG_KEBA_HEARTBEAT_STR = 'eebus-go.0.LPC.EnergyGuards.Guard_KEBA.heartbeat';
const EG_KEBA_LIMIT_STR = 'eebus-go.0.LPC.EnergyGuards.Guard_KEBA.currentLimit';

var tasmotaAlive = true;
var kebaEnabled = true;

async function tasmotaSendCommand(command) {
    try {
        const response = await axios.get('http://keba-failsafe.fritz.box/cm', {
            auth: {
                username: 'admin',
                password: getenv('PW_KEBA_FAILSAFE'),
            },
            params: {
                cmnd: command,
            },
            timeout: 5000,
            responseType: 'json',
        });

        // console.log(`KEBA command ${command}:`, response.status, response.data);
        tasmotaAlive = true;
        return true;
    } catch (error) {
        if (tasmotaAlive) {
            console.error(
                'KEBA command failed: ' +
                    JSON.stringify(
                        {
                            command: command,
                            status: error.response?.status,
                            data: error.response?.data,
                            message: error.message,
                        },
                        null,
                        2,
                    ),
            ); // The '2' formats it cleanly on multiple lines
            tasmotaAlive = false;
        }
        return false;
    }
}

async function tasmotaHeartbeat() {
    return tasmotaSendCommand('Event heartbeat=1');
}

async function tasmotaDisableKeba() {
    return tasmotaSendCommand('POWER1 OFF');
}

// The wallbox can switch from 1 phase loading to 3 phase loading or vice verca only every 5 minutes
// but we have to make sure that a limit gets applied instantly.
// We could check when the last switch happened but for simplicity we disable the wallbox in case limit
// is bolow 4.2 kW, which is minimun power for 3 phase loading
async function setLimit(value) {
    if (value > 1 && value < 4200) {
        await tasmotaDisableKeba();
        kebaEnabled = false;
        console.log('KEBA disabled due to low limit');
    } else {
        setState(KEBA_MAX_GRID_POWER_STR, value);
        kebaEnabled = true;
    }
}

// Heandle heartbeats every 30s
schedule('*/30 * * * * *', async () => {
    let kebaConnectedState = await getStateAsync(KEBA_CONNECTED_STR);
    // first check if wallbox adapter is connected and operational
    if (kebaConnectedState && kebaConnectedState.val === true && kebaEnabled) {
        // send heartbeat to tasmota switch and check for success
        let result = await tasmotaHeartbeat();
        if (result) {
            let kebaX1State = await getStateAsync(KEBA_X1_STR);
            // check state of X1, shows if wallbox is enabled and send hearbeat to EEBUS adapter
            if (kebaX1State && kebaX1State.val === true) {
                // signal to EEBUS guardian that KEBA is alive
                setState(EG_KEBA_HEARTBEAT_STR, true);

                // if KEBA was disabled by X1, re-enable it
                let kebaEnabledSys = await getStateAsync(KEBA_ENABLE_SYS_STR);
                let kebaEnabledUser = await getStateAsync(KEBA_ENABLE_USER_STR);
                if (kebaEnabledSys && kebaEnabledSys.val === false && kebaEnabledUser && kebaEnabledUser.val === true) {
                    setState(KEBA_ENABLE_USER_STR, true);
                }
            }
        }
    }
});

// subscribe to limit changes by EEBUS adapter
on({ id: EG_KEBA_LIMIT_STR, change: 'any' }, async obj => {
    let value = obj.state.val;
    await setLimit(value);
});

// check for active limits when script is started
async function init() {
    let kebaLimitState = await getStateAsync(EG_KEBA_LIMIT_STR);
    if (kebaLimitState) {
        await setLimit(kebaLimitState.val);
    }
}

init();
