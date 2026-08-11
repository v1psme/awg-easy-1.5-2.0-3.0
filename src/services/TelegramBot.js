'use strict';

const TelegramBot = require('../lib/TelegramBot');
const WireGuard = require('./WireGuard');

module.exports = new TelegramBot(WireGuard);
