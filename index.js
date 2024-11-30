const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');

const IotData = new AWS.IotData({ endpoint: 'ENDPOINT' });
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const tableName = 'smartbands_user_thing';

let currentUser = null;
let selectedThing = null;

async function getUserThings(username) {
    const params = { TableName: tableName };
    const data = await dynamoDb.scan(params).promise();
    return data.Items.filter(
        item => item.user.toLowerCase() === username.toLowerCase()
    ).map(item => ({ thingNick: item.thing_nick, serialNumber: item.serial_number }));
}

function getShadowPromise(thingName) {
    return IotData.getThingShadow({ thingName }).promise().then(data => JSON.parse(data.payload));
}

function updateShadowPromise(thingName, payload) {
    return IotData.updateThingShadow({ thingName, payload }).promise();
}

function buildResponse(handlerInput, speakOutput, reprompt = speakOutput) {
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(reprompt).getResponse();
}

async function validateUserAndThing(handlerInput, validateThing = false) {
    if (!currentUser) {
        return buildResponse(handlerInput, 'Primero debes proporcionar tu nombre de usuario. Por favor, dime tu nombre.');
    }

    if (validateThing && !selectedThing) {
        return buildResponse(handlerInput, 'Primero debes seleccionar un dispositivo. Por favor, dime el nombre del dispositivo que deseas usar.');
    }

    return null;
}

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        return buildResponse(handlerInput, 'Bienvenido a tu banda inteligente. Por favor, dime tu nombre de usuario para empezar.');
    }
};

const CaptureUsernameIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
               Alexa.getIntentName(handlerInput.requestEnvelope) === 'CaptureUsernameIntent';
    },
    async handle(handlerInput) {
        const username = handlerInput.requestEnvelope.request.intent.slots.username.value.toLowerCase();
        const userThings = await getUserThings(username);

        if (!userThings.length) {
            return buildResponse(handlerInput, 'No encontré dispositivos registrados para este usuario. Por favor, verifica tu nombre de usuario.');
        }

        currentUser = username;
        const thingsList = userThings.map(thing => thing.thingNick).join(', ');
        return buildResponse(handlerInput, `Hola ${username}. Tienes registrados los siguientes dispositivos: ${thingsList}. Por favor, dime el nombre del dispositivo que deseas usar.`);
    }
};

const SelectThingIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
               Alexa.getIntentName(handlerInput.requestEnvelope) === 'SelectThingIntent';
    },
    async handle(handlerInput) {
        const errorResponse = await validateUserAndThing(handlerInput);
        if (errorResponse) return errorResponse;

        const thingNick = handlerInput.requestEnvelope.request.intent.slots.thingNick.value.toLowerCase();
        const userThings = await getUserThings(currentUser);
        const selected = userThings.find(thing => thing.thingNick.toLowerCase() === thingNick);

        if (!selected) {
            return buildResponse(handlerInput, `No encontré un dispositivo llamado ${thingNick}. Por favor, intenta nuevamente.`);
        }

        selectedThing = selected.serialNumber;
        return buildResponse(handlerInput, `Perfecto. Ahora estás usando el dispositivo ${thingNick}. Puedes consultar tu ritmo cardíaco, SpO2, pasos, temperatura ambiente. ¿Qué deseas hacer?`);
    }
};

const createDataRequestHandler = (intentName, dataField, successMessage) => ({
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
               Alexa.getIntentName(handlerInput.requestEnvelope) === intentName;
    },
    async handle(handlerInput) {
        const errorResponse = await validateUserAndThing(handlerInput, true);
        if (errorResponse) return errorResponse;

        try {
            const thingTopic = `smartband_${selectedThing}`;
            await updateShadowPromise(thingTopic, JSON.stringify({ state: { desired: { data_requested: 1 } } }));
            await new Promise(resolve => setTimeout(resolve, 3000));
            const shadow = await getShadowPromise(thingTopic);
            const dataValue = shadow.state.reported[dataField];

            const speakOutput = dataValue
                ? `${successMessage}: ${dataValue}.`
                : `No se pudo obtener la información de ${dataField}. Intenta nuevamente.`;

            return buildResponse(handlerInput, speakOutput);
        } catch (error) {
            console.error(`Error en ${intentName}:`, error);
            return buildResponse(handlerInput, 'Hubo un problema al procesar tu solicitud. Por favor, intenta nuevamente más tarde.');
        }
    }
});

const CheckHeartbeatIntentHandler = createDataRequestHandler('CheckHeartbeatIntent', 'heart_rate', 'El pulso es');
const CheckActivityIntentHandler = createDataRequestHandler('CheckActivityIntent', 'activity_type', 'La actividad actual es');
const CheckTemperatureIntentHandler = createDataRequestHandler('CheckTemperatureIntent', 'enviroment_temperature', 'La temperatura del entorno es');
const CheckSpO2IntentHandler = createDataRequestHandler('CheckSpOIntent', 'SpO2', 'El nivel de oxígeno en la sangre es');
const CheckStepsIntentHandler = createDataRequestHandler('CheckStepsIntent', 'steps', 'El número de pasos es');

const ChangeMinHeartbeatIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
               Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChangeMinHeartbeatIntent';
    },
    async handle(handlerInput) {
        const errorResponse = await validateUserAndThing(handlerInput, true);
        if (errorResponse) return errorResponse;

        const minPulse = handlerInput.requestEnvelope.request.intent.slots.minPulse.value;

        try {
            const thingTopic = `smartband_${selectedThing}`;
            await updateShadowPromise(thingTopic, JSON.stringify({ state: { desired: { min_pulse_alert: parseInt(minPulse, 10) } } }));

            return buildResponse(handlerInput, `El umbral mínimo de pulsaciones se ha establecido en ${minPulse}.`);
        } catch (error) {
            console.error('Error en ChangeMinHeartbeatIntent:', error);
            return buildResponse(handlerInput, 'Hubo un problema al establecer el umbral mínimo. Por favor, intenta nuevamente más tarde.');
        }
    }
};

const ChangeMaxHeartbeatIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
               Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChangeMaxHeartbeatIntent';
    },
    async handle(handlerInput) {
        const errorResponse = await validateUserAndThing(handlerInput, true);
        if (errorResponse) return errorResponse;

        const maxPulse = handlerInput.requestEnvelope.request.intent.slots.maxPulse.value;

        try {
            const thingTopic = `smartband_${selectedThing}`;
            await updateShadowPromise(thingTopic, JSON.stringify({ state: { desired: { max_pulse_alert: parseInt(maxPulse, 10) } } }));

            return buildResponse(handlerInput, `El umbral máximo de pulsaciones se ha establecido en ${maxPulse}.`);
        } catch (error) {
            console.error('Error en ChangeMaxHeartbeatIntent:', error);
            return buildResponse(handlerInput, 'Hubo un problema al establecer el umbral máximo. Por favor, intenta nuevamente más tarde.');
        }
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        CaptureUsernameIntentHandler,
        SelectThingIntentHandler,
        CheckHeartbeatIntentHandler,
        CheckActivityIntentHandler,
        CheckTemperatureIntentHandler,
        CheckSpO2IntentHandler,
        ChangeMinHeartbeatIntentHandler,
        ChangeMaxHeartbeatIntentHandler,
        CheckStepsIntentHandler
    )
    .lambda();
