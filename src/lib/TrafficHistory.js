'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const debug = require('debug')('TrafficHistory');

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PERIODS = {
  day: {
    resolution: 'raw',
    durationMs: DAY_MS,
    maxSeriesPoints: 480,
  },
  week: {
    resolution: 'minute',
    durationMs: 7 * DAY_MS,
    maxSeriesPoints: 336,
  },
  month: {
    resolution: 'hour',
    durationMs: 30 * DAY_MS,
    maxSeriesPoints: 360,
  },
};

const toDateKey = (tsMs) => new Date(tsMs).toISOString().slice(0, 10);

const clampPositive = (value) => {
  return Number.isFinite(value) && value > 0 ? value : 0;
};

module.exports = class TrafficHistory {

  constructor({
    basePath,
    sampleIntervalSeconds = 1,
    rawRetentionHours = 24,
    minuteRetentionDays = 90,
    hourRetentionDays = 365,
  }) {
    this.basePath = path.join(basePath, 'traffic-history');
    this.sampleIntervalSeconds = sampleIntervalSeconds;
    this.rawRetentionHours = rawRetentionHours;
    this.minuteRetentionDays = minuteRetentionDays;
    this.hourRetentionDays = hourRetentionDays;
    this.previousSamples = new Map();
    this.latestSamples = new Map();
    this.minuteBuckets = new Map();
    this.hourBuckets = new Map();
    this.initPromise = null;
    this.lastPrunedAt = 0;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = Promise.all([
        fs.mkdir(path.join(this.basePath, 'raw'), { recursive: true }),
        fs.mkdir(path.join(this.basePath, 'minute'), { recursive: true }),
        fs.mkdir(path.join(this.basePath, 'hour'), { recursive: true }),
      ]);
    }

    return this.initPromise;
  }

  async recordClients(clients, now = new Date()) {
    await this.init();

    const tsMs = Math.floor(now.getTime() / SECOND_MS) * SECOND_MS;
    const minuteStartMs = tsMs - (tsMs % MINUTE_MS);
    const hourStartMs = tsMs - (tsMs % HOUR_MS);
    const rawLines = [];
    const flushPromises = [];

    for (const client of clients) {
      const sample = this.__buildSample(client, tsMs);
      rawLines.push(JSON.stringify(sample));

      const finishedMinuteBucket = this.__advanceBucket(this.minuteBuckets, minuteStartMs, sample);
      if (finishedMinuteBucket) {
        flushPromises.push(this.__flushBucket('minute', finishedMinuteBucket));
      }

      const finishedHourBucket = this.__advanceBucket(this.hourBuckets, hourStartMs, sample);
      if (finishedHourBucket) {
        flushPromises.push(this.__flushBucket('hour', finishedHourBucket));
      }
    }

    if (rawLines.length > 0) {
      flushPromises.push(this.__appendLines('raw', tsMs, rawLines));
    }

    await Promise.all(flushPromises);

    if (tsMs - this.lastPrunedAt >= HOUR_MS) {
      this.lastPrunedAt = tsMs;
      await this.prune(tsMs);
    }
  }

  async flush() {
    await this.init();

    const flushPromises = [];

    for (const bucket of this.minuteBuckets.values()) {
      flushPromises.push(this.__flushBucket('minute', bucket));
    }

    for (const bucket of this.hourBuckets.values()) {
      flushPromises.push(this.__flushBucket('hour', bucket));
    }

    this.minuteBuckets.clear();
    this.hourBuckets.clear();

    await Promise.all(flushPromises);
  }

  getLatestClients() {
    return [...this.latestSamples.values()]
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getLatestClient(clientId) {
    return this.latestSamples.get(clientId) || null;
  }

  async getClientHistory({
    clientId,
    period = 'day',
    now = new Date(),
  }) {
    await this.init();

    const periodConfig = PERIODS[period];
    if (!periodConfig) {
      throw new Error(`Unsupported period: ${period}`);
    }

    const untilMs = now.getTime();
    const sinceMs = untilMs - periodConfig.durationMs;
    const records = await this.__readRecords({
      resolution: periodConfig.resolution,
      clientId,
      sinceMs,
      untilMs,
    });

    const live = this.getLatestClient(clientId);
    const summary = periodConfig.resolution === 'raw'
      ? this.__summarizeRawRecords(records)
      : this.__summarizeAggregateRecords(records);
    const series = this.__compactSeries(records, {
      resolution: periodConfig.resolution,
      maxPoints: periodConfig.maxSeriesPoints,
    });

    return {
      period,
      resolution: periodConfig.resolution,
      sinceAt: new Date(sinceMs).toISOString(),
      untilAt: new Date(untilMs).toISOString(),
      live,
      summary,
      series,
    };
  }

  async prune(nowMs = Date.now()) {
    await this.__pruneResolution('raw', nowMs - (this.rawRetentionHours * HOUR_MS));
    await this.__pruneResolution('minute', nowMs - (this.minuteRetentionDays * DAY_MS));
    await this.__pruneResolution('hour', nowMs - (this.hourRetentionDays * DAY_MS));
  }

  __buildSample(client, tsMs) {
    const rxTotal = Number.isFinite(client.transferRx) ? Number(client.transferRx) : 0;
    const txTotal = Number.isFinite(client.transferTx) ? Number(client.transferTx) : 0;
    const previous = this.previousSamples.get(client.id);
    const elapsedSeconds = previous
      ? Math.max(1, (tsMs - previous.tsMs) / SECOND_MS)
      : this.sampleIntervalSeconds;
    const rxDelta = previous && rxTotal >= previous.rxTotal ? rxTotal - previous.rxTotal : 0;
    const txDelta = previous && txTotal >= previous.txTotal ? txTotal - previous.txTotal : 0;

    const sample = {
      ts: tsMs,
      clientId: client.id,
      name: client.name,
      address: client.address,
      enabled: client.enabled,
      connected: client.endpoint !== null,
      rxTotal,
      txTotal,
      rxRate: clampPositive(rxDelta / elapsedSeconds),
      txRate: clampPositive(txDelta / elapsedSeconds),
    };

    this.previousSamples.set(client.id, {
      tsMs,
      rxTotal,
      txTotal,
    });
    this.latestSamples.set(client.id, sample);

    return sample;
  }

  __advanceBucket(bucketMap, bucketStartMs, sample) {
    let bucket = bucketMap.get(sample.clientId);
    let finishedBucket = null;

    if (bucket && bucket.startMs !== bucketStartMs) {
      finishedBucket = bucket;
      bucket = null;
    }

    if (!bucket) {
      bucket = this.__createBucket(bucketStartMs, sample);
      bucketMap.set(sample.clientId, bucket);
    }

    this.__updateBucket(bucket, sample);
    return finishedBucket;
  }

  __createBucket(startMs, sample) {
    return {
      startMs,
      clientId: sample.clientId,
      name: sample.name,
      address: sample.address,
      enabled: sample.enabled,
      firstRxTotal: sample.rxTotal,
      firstTxTotal: sample.txTotal,
      lastRxTotal: sample.rxTotal,
      lastTxTotal: sample.txTotal,
      rxRateSum: 0,
      txRateSum: 0,
      rxRateMax: 0,
      txRateMax: 0,
      sampleCount: 0,
      connectedSamples: 0,
    };
  }

  __updateBucket(bucket, sample) {
    bucket.name = sample.name;
    bucket.address = sample.address;
    bucket.enabled = sample.enabled;
    bucket.lastRxTotal = sample.rxTotal;
    bucket.lastTxTotal = sample.txTotal;
    bucket.rxRateSum += sample.rxRate;
    bucket.txRateSum += sample.txRate;
    bucket.rxRateMax = Math.max(bucket.rxRateMax, sample.rxRate);
    bucket.txRateMax = Math.max(bucket.txRateMax, sample.txRate);
    bucket.sampleCount += 1;
    bucket.connectedSamples += sample.connected ? 1 : 0;
  }

  async __flushBucket(resolution, bucket) {
    if (!bucket || bucket.sampleCount === 0) {
      return;
    }

    const record = {
      ts: bucket.startMs,
      clientId: bucket.clientId,
      name: bucket.name,
      address: bucket.address,
      enabled: bucket.enabled,
      sampleCount: bucket.sampleCount,
      connectedSamples: bucket.connectedSamples,
      rxBytes: clampPositive(bucket.lastRxTotal - bucket.firstRxTotal),
      txBytes: clampPositive(bucket.lastTxTotal - bucket.firstTxTotal),
      rxRateAvg: bucket.rxRateSum / bucket.sampleCount,
      txRateAvg: bucket.txRateSum / bucket.sampleCount,
      rxRateMax: bucket.rxRateMax,
      txRateMax: bucket.txRateMax,
      rxTotal: bucket.lastRxTotal,
      txTotal: bucket.lastTxTotal,
    };

    await this.__appendLines(resolution, bucket.startMs, [JSON.stringify(record)]);
  }

  async __appendLines(resolution, tsMs, lines) {
    if (lines.length === 0) {
      return;
    }

    const filePath = path.join(this.basePath, resolution, `${toDateKey(tsMs)}.ndjson`);
    await fs.appendFile(filePath, `${lines.join('\n')}\n`);
  }

  async __pruneResolution(resolution, cutoffMs) {
    const dirPath = path.join(this.basePath, resolution);
    const cutoffDateKey = toDateKey(cutoffMs);
    const files = await fs.readdir(dirPath).catch(() => []);

    await Promise.all(files.map(async (fileName) => {
      if (!fileName.endsWith('.ndjson')) {
        return;
      }

      const dateKey = fileName.slice(0, -'.ndjson'.length);
      if (dateKey >= cutoffDateKey) {
        return;
      }

      try {
        await fs.unlink(path.join(dirPath, fileName));
      } catch (err) {
        debug(`Failed to prune ${resolution} file ${fileName}: ${err.message}`);
      }
    }));
  }

  async __readRecords({
    resolution,
    clientId,
    sinceMs,
    untilMs,
  }) {
    const dateKeys = this.__getDateKeysBetween(sinceMs, untilMs);
    const records = [];

    for (const dateKey of dateKeys) {
      const filePath = path.join(this.basePath, resolution, `${dateKey}.ndjson`);
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      if (!content) continue;

      for (const line of content.split('\n')) {
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (err) {
          debug(`Skipping invalid ${resolution} record: ${err.message}`);
          continue;
        }

        if (record.clientId !== clientId) continue;
        if (record.ts < sinceMs || record.ts > untilMs) continue;
        records.push(record);
      }
    }

    return records.sort((a, b) => a.ts - b.ts);
  }

  __getDateKeysBetween(sinceMs, untilMs) {
    const keys = [];
    const cursor = new Date(toDateKey(sinceMs));
    const end = toDateKey(untilMs);

    let currentKey = cursor.toISOString().slice(0, 10);
    while (currentKey <= end) {
      keys.push(currentKey);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      currentKey = cursor.toISOString().slice(0, 10);
    }

    return keys;
  }

  __summarizeRawRecords(records) {
    let rxBytes = 0;
    let txBytes = 0;
    let maxRxRate = 0;
    let maxTxRate = 0;

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      maxRxRate = Math.max(maxRxRate, record.rxRate);
      maxTxRate = Math.max(maxTxRate, record.txRate);

      if (index === 0) continue;

      const previous = records[index - 1];
      rxBytes += clampPositive(record.rxTotal - previous.rxTotal);
      txBytes += clampPositive(record.txTotal - previous.txTotal);
    }

    return {
      rxBytes,
      txBytes,
      maxRxRate,
      maxTxRate,
      sampleCount: records.length,
    };
  }

  __summarizeAggregateRecords(records) {
    let rxBytes = 0;
    let txBytes = 0;
    let maxRxRate = 0;
    let maxTxRate = 0;
    let sampleCount = 0;

    for (const record of records) {
      rxBytes += clampPositive(record.rxBytes);
      txBytes += clampPositive(record.txBytes);
      maxRxRate = Math.max(maxRxRate, record.rxRateMax || 0);
      maxTxRate = Math.max(maxTxRate, record.txRateMax || 0);
      sampleCount += record.sampleCount || 0;
    }

    return {
      rxBytes,
      txBytes,
      maxRxRate,
      maxTxRate,
      sampleCount,
    };
  }

  __compactSeries(records, {
    resolution,
    maxPoints,
  }) {
    if (!Array.isArray(records) || records.length === 0) {
      return [];
    }

    if (records.length <= maxPoints) {
      return records.map((record) => this.__compactRecord(record, resolution));
    }

    const bucketSize = Math.ceil(records.length / maxPoints);
    const compacted = [];

    for (let index = 0; index < records.length; index += bucketSize) {
      const bucket = records.slice(index, index + bucketSize);
      compacted.push(this.__compactBucket(bucket, resolution));
    }

    return compacted;
  }

  __compactRecord(record, resolution) {
    if (resolution === 'raw') {
      return {
        ts: record.ts,
        rxRate: record.rxRate || 0,
        txRate: record.txRate || 0,
      };
    }

    return {
      ts: record.ts,
      rxRateAvg: record.rxRateAvg || 0,
      txRateAvg: record.txRateAvg || 0,
    };
  }

  __compactBucket(bucket, resolution) {
    const last = bucket[bucket.length - 1];

    if (resolution === 'raw') {
      return {
        ts: last.ts,
        rxRate: bucket.reduce((sum, record) => sum + (record.rxRate || 0), 0) / bucket.length,
        txRate: bucket.reduce((sum, record) => sum + (record.txRate || 0), 0) / bucket.length,
      };
    }

    const totalSamples = bucket.reduce((sum, record) => sum + (record.sampleCount || 1), 0);

    return {
      ts: last.ts,
      rxRateAvg: bucket.reduce((sum, record) => {
        return sum + ((record.rxRateAvg || 0) * (record.sampleCount || 1));
      }, 0) / totalSamples,
      txRateAvg: bucket.reduce((sum, record) => {
        return sum + ((record.txRateAvg || 0) * (record.sampleCount || 1));
      }, 0) / totalSamples,
    };
  }

};
