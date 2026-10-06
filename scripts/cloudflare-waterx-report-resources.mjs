const DAY_MS = 86_400_000;

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricDataset(metrics, name) {
  const dataset = metrics?.datasets?.[name];
  if (!dataset || dataset.availability !== "available" ||
      dataset.possiblyTruncated || !Array.isArray(dataset.rows) || dataset.rows.length === 0)
    return null;
  return dataset;
}

function freshnessIsKnownAndWithinLimit(metrics, dataset) {
  const freshness = dataset?.freshness;
  const windowEnd = Date.parse(metrics?.timeWindow?.end ?? "");
  const latest = Date.parse(freshness?.latestDataTimestamp ?? "");
  const reference = Date.parse(freshness?.referenceTime ?? "");
  const lag = numeric(freshness?.lagSeconds);
  const staleLimit = numeric(freshness?.staleLimitSeconds);
  if (!Number.isFinite(windowEnd) || !Number.isFinite(latest) ||
      reference !== windowEnd || freshness?.referenceTime !== metrics.timeWindow.end ||
      freshness?.referenceBasis !== "requested_analytics_window_end" ||
      lag === null || staleLimit === null || lag < 0 || staleLimit <= 0 ||
      latest > windowEnd || lag > staleLimit)
    return false;
  return lag === Math.max(0, Math.floor((windowEnd - latest) / 1000));
}

function metricFieldDataset(metrics, name, group, field) {
  const dataset = metrics?.datasets?.[name];
  if (!dataset || !["available", "partial"].includes(dataset.availability) ||
      dataset.possiblyTruncated || !Array.isArray(dataset.rows) ||
      dataset.rows.length === 0 ||
      !dataset.selectedFields?.[group]?.includes(field) ||
      !freshnessIsKnownAndWithinLimit(metrics, dataset))
    return null;
  return dataset;
}

function metricSum(metrics, name, field) {
  const dataset = metricFieldDataset(metrics, name, "sum", field);
  if (!dataset) return null;
  const values = dataset.rows.map(row => numeric(row?.sum?.[field]));
  if (values.some(value => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function metricMax(metrics, name, group, field) {
  const dataset = metricFieldDataset(metrics, name, group, field);
  if (!dataset) return null;
  const values = dataset.rows.map(row => numeric(row?.[group]?.[field]));
  if (!values.length || values.some(value => value === null)) return null;
  return Math.max(...values);
}

export function metricsWindowIsFullDay(metrics, expectedStart, expectedEnd) {
  const actual = metrics?.timeWindow;
  const actualStart = Date.parse(actual?.start ?? "");
  const actualEnd = Date.parse(actual?.end ?? "");
  return Number.isFinite(expectedStart) && Number.isFinite(expectedEnd) &&
    actualStart === expectedStart && actualEnd === expectedEnd &&
    expectedEnd - expectedStart === DAY_MS &&
    Number(actual?.durationSeconds) === DAY_MS / 1000;
}

function datasetStatus(metrics, name) {
  const dataset = metrics?.datasets?.[name];
  if (!dataset) return { status: "not_measured", reason: "dataset_not_returned" };
  const fresh = freshnessIsKnownAndWithinLimit(metrics, dataset);
  return {
    status: dataset.availability === "available" &&
      !dataset.possiblyTruncated && fresh
      ? "verified" : "not_measured",
    availability: dataset.availability ?? "unknown",
    possiblyTruncated: dataset.possiblyTruncated ?? false,
    reason: dataset.reason ?? null,
    freshness: dataset.freshness ?? null,
    freshnessVerifiedWithinLimit: fresh,
  };
}

function validStoragePoints(metrics) {
  const dataset = metricFieldDataset(metrics, "d1Storage", "max", "databaseSizeBytes");
  if (!dataset) return [];
  return dataset.rows.map(row => {
    const datetime = row.dimensions?.datetime ?? row.dimensions?.datetimeHour ??
      row.dimensions?.datetimeFifteenMinutes ?? row.dimensions?.datetimeFiveMinutes ??
      row.dimensions?.datetimeMinute ?? row.dimensions?.date;
    const timestamp = typeof datetime === "string" ? Date.parse(datetime) : NaN;
    const size = numeric(row.max?.databaseSizeBytes);
    return { timestamp, size };
  }).filter(point => Number.isFinite(point.timestamp) && point.size !== null)
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function buildMonthlyProjection(metrics, evidenceComplete, expectedWindow) {
  const fullMetricsDay = metricsWindowIsFullDay(
    metrics, expectedWindow.startMs, expectedWindow.endMs,
  );
  const calculationMetrics = fullMetricsDay ? metrics : null;
  const dayRows = {
    workerRequests: metricSum(calculationMetrics, "workerCpuAndRequests", "requests"),
    durableObjectRequests: metricSum(calculationMetrics, "durableObjectInvocations", "requests"),
    durableObjectCpuTime: metricSum(calculationMetrics, "durableObjectPeriodic", "cpuTime"),
    durableObjectDuration: metricSum(calculationMetrics, "durableObjectPeriodic", "duration"),
    d1RowsRead: metricSum(calculationMetrics, "d1Analytics", "rowsRead"),
    d1RowsWritten: metricSum(calculationMetrics, "d1Analytics", "rowsWritten"),
  };
  const datasets = [
    "workerCpuAndRequests",
    "durableObjectInvocations",
    "durableObjectPeriodic",
    "durableObjectStorage",
    "d1Analytics",
    "d1Queries",
    "d1Storage",
  ];
  const quality = Object.fromEntries(datasets.map(name => [name, datasetStatus(metrics, name)]));
  const requiredValues = Object.values(dayRows);
  const allDailyUsagePresent = requiredValues.every(value => value !== null);
  const anyDailyUsagePresent = requiredValues.some(value => value !== null);
  const eligible = fullMetricsDay && evidenceComplete && anyDailyUsagePresent;
  const points = validStoragePoints(calculationMetrics);
  const storageSize = metricMax(calculationMetrics, "d1Storage", "max", "databaseSizeBytes");
  let storageProjection = {
    currentBytes: storageSize,
    measuredGrowthBytesPerDay: null,
    after30DaysBytes: null,
    after31DaysBytes: null,
    assumption: "90-day snapshots/coverage, 7-day pending-settlement retention, and unpruned round-first/settlement evidence per the worker source; future net D1 growth is assumed linear only when at least two time-separated storage observations are available.",
    status: "not_measured",
  };
  if (eligible && points.length >= 2 &&
      points.at(-1).timestamp > points[0].timestamp) {
    const elapsedDays = (points.at(-1).timestamp - points[0].timestamp) / DAY_MS;
    const dailyGrowth = (points.at(-1).size - points[0].size) / elapsedDays;
    storageProjection = {
      ...storageProjection,
      currentBytes: points.at(-1).size,
      measuredGrowthBytesPerDay: dailyGrowth,
      after30DaysBytes: Math.max(0, points.at(-1).size + dailyGrowth * 30),
      after31DaysBytes: Math.max(0, points.at(-1).size + dailyGrowth * 31),
      measurementPoints: points.length,
      status: "verified_measured_slope_linear_projection",
    };
  }
  const limits = {
    workerRequestsPerDay: 100_000,
    durableObjectRequestsPerDay: 100_000,
    durableObjectRowsReadPerDay: 5_000_000,
    durableObjectRowsWrittenPerDay: 100_000,
    durableObjectDurationGBSecondsPerDay: 13_000,
    d1RowsReadPerDay: 5_000_000,
    d1RowsWrittenPerDay: 100_000,
    workerCpuMsPerInvocation: 10,
    d1DatabaseBytes: 500 * 1024 * 1024,
    accountD1StorageBytes: 5 * 1024 * 1024 * 1024,
    scope: "Cloudflare account-shared limits where applicable; usage by other account resources is not measured here.",
  };
  const projections = {};
  for (const days of [30, 31]) {
    const total = Object.fromEntries(Object.entries(dayRows).map(([key, value]) =>
      [key, value === null ? null : value * days]));
    if (!eligible)
      for (const key of Object.keys(total)) total[key] = null;
    projections[`${days}DayMonth`] = {
      projectedTotal: total,
      projectedAverageDay: eligible ? { ...dayRows } : null,
      comparison: "Daily quota comparisons use observed daily use against daily limits; monthly totals are shown as context and are not compared to daily quotas.",
    };
  }
  const workerP99Micros = metricMax(calculationMetrics, "workerCpuAndRequests", "quantiles", "cpuTimeP99");
  const doP99Micros = metricMax(calculationMetrics, "durableObjectInvocations", "quantiles", "cpuTimeP99");
  const doRowsRead = metricSum(calculationMetrics, "durableObjectPeriodic", "rowsRead");
  const doRowsWritten = metricSum(calculationMetrics, "durableObjectPeriodic", "rowsWritten");
  const doDurationGBSeconds = metricSum(calculationMetrics, "durableObjectPeriodic", "duration");
  const doDurationDescription =
    metrics?.datasets?.durableObjectPeriodic?.unitsAndFieldDescriptions?.["sum.duration"] ?? null;
  const doDurationUnitsVerified = typeof doDurationDescription === "string" &&
    /GB\s*\*?\s*s/i.test(doDurationDescription);
  const storageActual = storageSize;
  return {
    availability: eligible
      ? allDailyUsagePresent ? "verified_for_observed_day_only" : "partial_measured_day"
      : "not_measured_or_incomplete",
    projectionEligible: eligible,
    projectionBlockedReasons: [
      ...(!fullMetricsDay ? ["metrics_window_does_not_exactly_match_fixed_first_24_hours"] : []),
      ...(!evidenceComplete ? ["fixed_first_24_hour_evidence_window_not_complete"] : []),
      ...(!anyDailyUsagePresent ? ["all_daily_usage_aggregates_missing"] : []),
    ],
    datasetLimitations: datasets.filter(name => {
      const dataset = metrics?.datasets?.[name];
      return !dataset || dataset.availability !== "available" ||
        dataset.possiblyTruncated || !Array.isArray(dataset.rows) ||
        dataset.rows.length === 0 ||
        !freshnessIsKnownAndWithinLimit(metrics, dataset);
    }).map(name => `dataset_${name}_not_complete`),
    metricsWindow: metrics?.timeWindow ?? null,
    metricsFreshnessBasis: "Lag is measured relative to this fixed requested window's end, not the wall-clock report time; source metric grouping and service lag limit exact boundary/freshness interpretation.",
    cloudflareDatasets: quality,
    actualDailyUsage: fullMetricsDay ? dayRows : null,
    actualDailyUsageFieldCompleteness: {
      completeAllFields: allDailyUsagePresent,
      availableFields: Object.keys(dayRows).filter(field => dayRows[field] !== null),
      unavailableFields: Object.keys(dayRows).filter(field => dayRows[field] === null),
      qualification: "Each daily aggregate is emitted only if that exact field was selected, not truncated or stale relative to the requested window end, and numeric in every returned metric row; other fields in a dataset may remain partial or unavailable.",
    },
    limits,
    dailyQuotaChecks: {
      workerRequests: dayRows.workerRequests === null ? "not_measured" : {
        observedPerDay: dayRows.workerRequests,
        includedLimitPerDay: limits.workerRequestsPerDay,
        utilizationOfSharedLimit: dayRows.workerRequests / limits.workerRequestsPerDay,
        remainingIfNoOtherAccountUsage: Math.max(0,
          limits.workerRequestsPerDay - dayRows.workerRequests),
        accountOtherUsage: "unknown_not_measured",
        actualAccountSharedRemaining: "unknown",
      },
      durableObjectRequests: dayRows.durableObjectRequests === null ? "not_measured" : {
        observedPerDay: dayRows.durableObjectRequests,
        includedLimitPerDay: limits.durableObjectRequestsPerDay,
        utilizationOfSharedLimit: dayRows.durableObjectRequests / limits.durableObjectRequestsPerDay,
        remainingIfNoOtherAccountUsage: Math.max(0,
          limits.durableObjectRequestsPerDay - dayRows.durableObjectRequests),
        accountOtherUsage: "unknown_not_measured",
        actualAccountSharedRemaining: "unknown",
      },
      d1RowsRead: dayRows.d1RowsRead === null ? "not_measured" : {
        observedPerDay: dayRows.d1RowsRead,
        includedLimitPerDay: limits.d1RowsReadPerDay,
        utilization: dayRows.d1RowsRead / limits.d1RowsReadPerDay,
        remainingIfNoOtherAccountUsage: Math.max(0,
          limits.d1RowsReadPerDay - dayRows.d1RowsRead),
        actualAccountSharedRemaining: "unknown",
      },
      d1RowsWritten: dayRows.d1RowsWritten === null ? "not_measured" : {
        observedAnalyticsRowsWritten: dayRows.d1RowsWritten,
        includedLimitPerDay: limits.d1RowsWrittenPerDay,
        utilizationLowerBound: dayRows.d1RowsWritten / limits.d1RowsWrittenPerDay,
        remainingFromObservedAnalyticsOnlyUpperBound: Math.max(0,
          limits.d1RowsWrittenPerDay - dayRows.d1RowsWritten),
        actualAccountSharedRemaining: "unknown",
        caveat: "D1 analytics row counts may not include index writes; the quota is index-inclusive.",
      },
      workerCpu: workerP99Micros === null ? "not_measured" : {
        maximumReportedP99Microseconds: workerP99Micros,
        maximumReportedP99Milliseconds: workerP99Micros / 1000,
        perInvocationLimitMilliseconds: limits.workerCpuMsPerInvocation,
        remainingAtReportedP99Milliseconds: Math.max(0,
          limits.workerCpuMsPerInvocation - workerP99Micros / 1000),
        note: "A p99 quantile is not an all-invocation maximum or a daily CPU total.",
      },
      durableObjectCpuAndDuration: {
        cpuTimeReportedDaily: dayRows.durableObjectCpuTime,
        durationReportedDaily: dayRows.durableObjectDuration,
        invocationP99CpuMicroseconds: doP99Micros,
        durationUnitDescription: doDurationDescription,
        durationQuota: doDurationGBSeconds === null || !doDurationUnitsVerified
          ? "not_measured"
          : {
            observedGBSecondsPerDay: doDurationGBSeconds,
            includedLimitGBSecondsPerDay: limits.durableObjectDurationGBSecondsPerDay,
            utilization: doDurationGBSeconds /
              limits.durableObjectDurationGBSecondsPerDay,
            remainingIfNoOtherAccountUsage: Math.max(0,
              limits.durableObjectDurationGBSecondsPerDay - doDurationGBSeconds),
            actualAccountSharedRemaining: "unknown",
          },
        dailyCpuTimeUnit: metrics?.datasets?.durableObjectPeriodic
          ?.unitsAndFieldDescriptions?.["sum.cpuTime"] ?? null,
        dailyCpuTimeLimitComparison: "not_measured_without a matching stated per-day CPU quota",
      },
      d1Storage: {
        measuredBytes: storageActual,
        perDatabaseCapBytes: limits.d1DatabaseBytes,
        accountCapBytes: limits.accountD1StorageBytes,
        remainingPerDatabaseIfMeasurementCurrent: storageActual === null
          ? null : Math.max(0, limits.d1DatabaseBytes - storageActual),
        utilizationOfPerDatabaseCap: storageActual === null
          ? null : storageActual / limits.d1DatabaseBytes,
        accountOtherDatabaseStorage: "unknown_not_measured",
        actualAccountSharedRemainingBytes: "unknown",
        projectedStorageAgainstPerDatabaseCap: {
          after30Days: storageProjection.after30DaysBytes === null
            ? "not_measured" : {
              bytes: storageProjection.after30DaysBytes,
              withinLimit: storageProjection.after30DaysBytes <= limits.d1DatabaseBytes,
            },
          after31Days: storageProjection.after31DaysBytes === null
            ? "not_measured" : {
              bytes: storageProjection.after31DaysBytes,
              withinLimit: storageProjection.after31DaysBytes <= limits.d1DatabaseBytes,
            },
        },
        monthProjection: storageProjection,
      },
      durableObjectStorageAndOperations: {
        dailyOperationMetrics: Object.fromEntries([
          "cpuTime", "duration", "rowsRead", "rowsWritten",
          "storageReadUnits", "storageWriteUnits", "billedTime",
        ].map(field => [field, metricSum(calculationMetrics, "durableObjectPeriodic", field)])),
        storageSizeMetric: metricDataset(calculationMetrics, "durableObjectStorage")?.rows ?? null,
        unitsAndDescriptions: metrics?.datasets?.durableObjectPeriodic?.unitsAndFieldDescriptions ?? null,
        dailyQuotaChecks: {
          rowsRead: doRowsRead === null ? "not_measured" : {
            observedPerDay: doRowsRead,
            includedLimitPerDay: limits.durableObjectRowsReadPerDay,
            utilization: doRowsRead / limits.durableObjectRowsReadPerDay,
            remainingIfNoOtherAccountUsage: Math.max(0,
              limits.durableObjectRowsReadPerDay - doRowsRead),
            actualAccountSharedRemaining: "unknown",
          },
          rowsWritten: doRowsWritten === null ? "not_measured" : {
            observedPerDay: doRowsWritten,
            includedLimitPerDay: limits.durableObjectRowsWrittenPerDay,
            utilization: doRowsWritten / limits.durableObjectRowsWrittenPerDay,
            remainingIfNoOtherAccountUsage: Math.max(0,
              limits.durableObjectRowsWrittenPerDay - doRowsWritten),
            actualAccountSharedRemaining: "unknown",
          },
        },
        comparison: "Field-level totals are included only when that field was selected and all returned rows contain numeric values. Use per-day SQLite reads/writes/size when exposed; account-wide remainder is not measured.",
      },
    },
    monthlyProjection: projections,
    separateOneTimeCosts: {
      reportD1Reads: "not separately measured; the read-only report's D1 query metadata is not exposed through this API result.",
      initialProvisioningAndWarmup: "not separately measured by this report.",
      steadyCollectionVersusReportTraffic: "Cloudflare analytics include all matching resource traffic; this report cannot isolate one-time setup or its own reads.",
    },
    assumptions: {
      accountSharedLimits: true,
      retention: "snapshots and coverage: 90 days; pending settlement: 7 days; first-round and settlement evidence are not pruned in worker source",
      linearGrowth: "Only applied to observed storage slope when at least two separate timestamps are returned; otherwise no storage-growth projection.",
      browserAndReadTraffic: "Additional browsers/adapters would add account-shared Worker/D1 usage; none is budgeted.",
    },
  };
}