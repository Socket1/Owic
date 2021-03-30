const { PriceFeedInterface } = require("./PriceFeedInterface");
const { parseFixed } = require("@uma/common");
const moment = require("moment");
const assert = require("assert");

// Constants
const VALID_OHLC_PERIODS = [1, 5, 10, 15, 30];
const MAX_MINUTE_LOOKBACK = 172800; // 2 days
const MAX_HOURLY_LOOKBACK = 5184000; // 2 months

// An implementation of PriceFeedInterface that uses TraderMade api to retrieve prices.
class TraderMadePriceFeed extends PriceFeedInterface {
  /**
   * @notice Constructs the TraderMadePriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {Object} web3 Provider from truffle instance to connect to Ethereum network.
   * @param {String} pair Representation of the pair the price feed is tracking.
   * @param {String} apiKey TraderMade Data API key.
   * @param {Integer} minuteLookback Maximum 172800 lookback. How far in the past the historical prices will be available
   *                  using getHistoricalPrice. The minute timeseries is the default one to use to fetch historical prices.
   *                  Moreover, TradeMadeAPI timeseries data is unavailable over the weekend,
   *                  (generally the period between Friday 22:00 GMT and Sunday 22:00 GMT). Because of the minute-timeseries'
   *                  shorter lookback, this feed is configured to use the hourly timeseries as a fallback in case there
   *                  is no minute timeseries data. Therefore to take advantage of this, we recommend setting either
   *                  the `hourlyLookback` to be longer than 3 days (259200 seconds) so that the hourly timeseries always contains
   *                  the last known price prior to the weekend start. This allows us to simultaneously set a shorter minute
   *                  lookback. For example, if `minuteLookback = 7200`, then 2 hours after the weekend has "begun",
   *                  `TraderMadePriceFeed.updateMinute()` will fail to find any prices. Simultaneously setting
   *                  `hourLookback = 604800` ensures that if `updateMinute()` fails then `updateHourly()` will return the last
   *                  hourly price. Alternatively, you can set `minuteLookback = 172800` (the maximum minute interval lookback)
   *                  which will allow `updateMinute()` to fetch data for longer into the off-market period.
   *                  We like setting `minuteLookback` to 7200 and `hourlyLookback` to 604800 so that we can both reduce the
   *                  amount of data to parse from the minute-interval and ensure that we can always find a price when
   *                  weekend prices are not available.
   * @param {Integer} hourlyLookback Maximum 5184000 lookback. How far in the past the historical prices will be available
   *                  using getHistoricalPricePeriods. Hourly historical prices can also be used as a fallback to the
   *                  minute timeseries if no minute data is available.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Number} ohlcPeriod Number of minutes interval between ohlc prices requested from TraderMade. Must be
   *                 one of {1, 5, 10, 15, 30}
   */
  constructor(
    logger,
    web3,
    apiKey,
    pair,
    minuteLookback,
    hourlyLookback,
    networker,
    getTime,
    minTimeBetweenUpdates,
    priceFeedDecimals = 18,
    ohlcPeriod = 1
  ) {
    super();
    this.logger = logger;
    this.web3 = web3;

    this.apiKey = apiKey;
    this.pair = pair;

    // Sanitize API specific parameters:
    assert(VALID_OHLC_PERIODS.includes(ohlcPeriod), `ohlcPeriod must be one of ${JSON.stringify(VALID_OHLC_PERIODS)}`);
    assert(minuteLookback <= MAX_MINUTE_LOOKBACK, `minuteLookback must be < ${MAX_MINUTE_LOOKBACK}`);
    assert(hourlyLookback <= MAX_HOURLY_LOOKBACK, `hourlyLookback must be < ${MAX_HOURLY_LOOKBACK}`);

    this.minuteLookback = minuteLookback;
    this.hourlyLookback = hourlyLookback;
    this.uuid = `TraderMade-${pair}`;
    this.networker = networker;
    this.getTime = getTime;
    this.minTimeBetweenUpdates = minTimeBetweenUpdates;

    this.toBN = this.web3.utils.toBN;
    this.ohlcPeriod = ohlcPeriod;

    this.priceFeedDecimals = priceFeedDecimals;
    this.ohlcPeriod = ohlcPeriod;

    this.convertPriceFeedDecimals = number => {
      // Converts price result to wei
      // returns price conversion to correct decimals as a big number
      return this.toBN(parseFixed(number.toString(), priceFeedDecimals).toString());
    };
  }

  getCurrentPrice() {
    return this.currentPrice;
  }

  async getHistoricalPrice(time, verbose = false) {
    if (this.lastUpdateTime === undefined) {
      throw new Error(`${this.uuid}: undefined lastUpdateTime`);
    }

    // Set first price time in `historicalPrices` to first non-null price.
    let firstPriceTime;

    // Note: The TraderMade API does not update /timeseries data over the weekend, so to handle this case we can fall back
    // on the longer lookback window of the hourly timeseries. (The lookback limit for the minute inverval is 2 days, while
    // the limit for the hourly interval is 2 months). This fall back logic will only work if `this.hourlyLookback` is
    // configured long enough such that there is an hourly price available.
    let historicalPricesToCheck = this.historicalPricesMinute
      ? this.historicalPricesMinute
      : this.historicalPricesHourly;
    for (let p in historicalPricesToCheck) {
      if (historicalPricesToCheck[p] && historicalPricesToCheck[p].openTime) {
        firstPriceTime = historicalPricesToCheck[p];
        break;
      }
    }

    // If there are no valid price time, return null.
    if (!firstPriceTime) {
      throw new Error(`${this.uuid}: no valid price time`);
    }

    // If the time is before the first piece of data in the set, return null because
    // the price is before the lookback window.
    if (time < firstPriceTime.openTime) {
      throw new Error(`${this.uuid}: time ${time} is before firstPriceTime.openTime`);
    }

    // historicalPricesToCheck are ordered from oldest to newest.
    // This finds the first priceTime whose closeTime is after the provided time.
    const match = historicalPricesToCheck.find(price => {
      return time < price.closeTime;
    });

    // If there is no match, that means that the time was past the last data point.
    // In this case, the best match for this price is the current price.
    let returnPrice;
    if (match === undefined) {
      returnPrice = this.currentPrice;
      if (verbose) {
        console.group(`\n(${this.pair}) No OHLC available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${this.web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.log(
          `- ⚠️  If you want to manually verify the specific exchange prices, you can make a GET request to: \n- https://marketdata.tradermade.com/api/v1/live?currency=${this.pair}&api_key={api-key}`
        );
        console.groupEnd();
      }
      return this.currentPrice;
    }

    returnPrice = match.closePrice;
    if (verbose) {
      console.group(`\n(${this.pair}) Historical OHLC @ ${match.closeTime}`);
      console.log(`- ✅ Close Price:${this.web3.utils.fromWei(returnPrice.toString())}`);
      console.log(
        `- ⚠️  If you want to manually verify the specific exchange prices, you can make a GET request to: \n- https://marketdata.tradermade.com/api/v1/timeseries?currency=${this.pair}&api_key={api-key}&start_date=${time}&end_date=${match.closeTime}&format=records&interval=minute&period=${this.ohlcPeriod}`
      );
      console.groupEnd();
    }
    return returnPrice;
  }

  getHistoricalPricePeriods() {
    return this.historicalPricesHourly;
  }

  getLastUpdateTime() {
    return this.lastUpdateTime;
  }

  getMinuteLookback() {
    return this.minuteLookback;
  }

  getHourlyLookback() {
    return this.hourlyLookback;
  }

  getPriceFeedDecimals() {
    return this.priceFeedDecimals;
  }

  // Documentation for `/live` endpoint found here:
  // - https://tradermade.com/exchange-rate-api/documentation#live_rates
  async updateLatest(lastUpdateTime) {
    const currentTime = this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== undefined && lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "TraderMadePriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTimes + this.minTimeBetweenUpdates - currentTime
      });
      return;
    }

    this.logger.debug({
      at: "TraderMade_PriceFeed",
      message: "Updating Latest Price",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    // 1. Construct URLs.
    const priceUrl = `https://marketdata.tradermade.com/api/v1/live?currency=${this.pair}&api_key=${this.apiKey}`;

    // 2. Send requests.
    const priceResponse = await this.networker.getJson(priceUrl);

    // 4. Parse results.
    // Return data structure:
    //  {
    //     "endpoint": "live",
    //     "quotes": [
    //       {
    //         "ask": 0.15431,
    //         "base_currency": "CNY",
    //         "bid": 0.15431,
    //         "mid": 0.15431,
    //         "quote_currency": "USD"
    //       }
    //     ],
    //     "requested_time": "Tue, 26 Jan 2021 01:29:52 GMT",
    //     "timestamp": 1611624593
    //   }
    // For more info, see: https://marketdata.tradermade.com/documentation
    const newPrice = this.convertPriceFeedDecimals(priceResponse.quotes[0].ask);

    // 5. Store results.
    this.currentPrice = newPrice;
    this.lastUpdateTime = currentTime;
  }

  // Documentation for the `/timeseries` endpoint found here:
  // - https://tradermade.com/exchange-rate-api/documentation#timeseries
  async updateMinute(lastUpdateTime) {
    const currentTime = this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== undefined && lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      return;
    }

    this.logger.debug({
      at: "TraderMade_PriceFeed",
      message: "Updating Minute Price",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    // Round down to the nearest ohlc period so the queries captures the OHLC of the period *before* this earliest
    // timestamp (because the close of that OHLC may be relevant).
    const earliestMinuteHistoricalTimestamp =
      Math.floor((currentTime - this.minuteLookback) / (this.ohlcPeriod * 60)) * (this.ohlcPeriod * 60);
    const endDate = this._secondToDateTime(currentTime);
    const startMinuteDate = this._secondToDateTime(earliestMinuteHistoricalTimestamp);

    // 1. Construct URLs.
    const ohlcMinuteUrl = `https://marketdata.tradermade.com/api/v1/timeseries?currency=${this.pair}&api_key=${this.apiKey}&start_date=${startMinuteDate}&end_date=${endDate}&format=records&interval=minute&period=${this.ohlcPeriod}`;

    // 2. Send requests.
    const ohlcMinuteResponse = await this.networker.getJson(ohlcMinuteUrl);

    // 3. Check responses.
    if (!ohlcMinuteResponse || ohlcMinuteResponse.quotes.length === 0 || !ohlcMinuteResponse.quotes[0]?.close) {
      throw new Error(
        `🚨Could not parse ohlc minute price result from url ${ohlcMinuteUrl}: ${JSON.stringify(ohlcMinuteResponse)}`
      );
    }

    // Return data structure:
    // {
    //   "base_currency": "CNY",
    //   "end_date": "2021-01-26 03:31:00",
    //   "endpoint": "timeseries",
    //   "quote_currency": "USD",
    //   "quotes": [
    //     {
    //       "close": 0.1543,
    //       "date": "2021-01-26 00:01:00",
    //       "high": 0.1543,
    //       "low": 0.1543,
    //       "open": 0.1543
    //     },
    //     ...
    //   ]
    //   "request_time": "Wed, 27 Jan 2021 01:45:28 GMT",
    //   "start_date": "2021-01-26-00:01"
    // }
    // For more info, see: https://marketdata.tradermade.com/documentation
    const newHistoricalPricesMinute = ohlcMinuteResponse.quotes
      .map(ohlcMinute => ({
        // Output data should be a list of objects with only the open and close times and prices.
        closePrice: this.convertPriceFeedDecimals(ohlcMinute.close),
        openTime: this._dateTimeToSecond(ohlcMinute.date) - this.ohlcPeriod * 60,
        closeTime: this._dateTimeToSecond(ohlcMinute.date)
      }))
      .sort((a, b) => {
        // Sorts the data such that the oldest elements come first.
        return a.openTime - b.openTime;
      });

    // 5. Store results.
    this.historicalPricesMinute = newHistoricalPricesMinute;
  }

  async updateHourly(lastUpdateTime) {
    const currentTime = this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== undefined && lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      return;
    }

    this.logger.debug({
      at: "TraderMade_PriceFeed",
      message: "Updating Hourly Price",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime
    });

    // Round down to the nearest ohlc period so the queries captures the OHLC of the period *before* this earliest
    // timestamp (because the close of that OHLC may be relevant).
    const earliestHourlyHistoricalTimestamp = Math.floor((currentTime - this.hourlyLookback) / 3600) * 3600;
    const endDate = this._secondToDateTime(currentTime);
    const startHourlyDate = this._secondToDateTime(earliestHourlyHistoricalTimestamp);

    // 1. Construct URLs.
    const ohlcHourlyUrl = `https://marketdata.tradermade.com/api/v1/timeseries?currency=${this.pair}&api_key=${this.apiKey}&start_date=${startHourlyDate}&end_date=${endDate}&format=records&interval=hourly`;

    // 2. Send requests.
    const ohlcHourlyResponse = await this.networker.getJson(ohlcHourlyUrl);

    // 3. Check responses.

    if (!ohlcHourlyResponse || ohlcHourlyResponse.quotes.length === 0 || !ohlcHourlyResponse.quotes[0].close) {
      throw new Error(
        `🚨Could not parse ohlc hourly price result from url ${ohlcHourlyUrl}: ${JSON.stringify(ohlcHourlyResponse)}`
      );
    }

    // Return data structure:
    // {
    //   "base_currency": "CNY",
    //   "end_date": "2021-01-26 03:31:00",
    //   "endpoint": "timeseries",
    //   "quote_currency": "USD",
    //   "quotes": [
    //     {
    //       "close": 0.1543,
    //       "date": "2021-01-26 00:00:00",
    //       "high": 0.1543,
    //       "low": 0.1543,
    //       "open": 0.1543
    //     },
    //     ...
    //   ]
    //   "request_time": "Wed, 27 Jan 2021 01:45:28 GMT",
    //   "start_date": "2021-01-26-00:01"
    // }
    // For more info, see: https://marketdata.tradermade.com/documentation
    const newHistoricalPricesHourly = ohlcHourlyResponse.quotes
      .map(ohlcHourly => ({
        // Output data should be a list of objects with only the open and close times and prices.
        closePrice: this.convertPriceFeedDecimals(ohlcHourly.close),
        openTime: this._dateTimeToSecond(ohlcHourly.date) - 3600,
        closeTime: this._dateTimeToSecond(ohlcHourly.date)
      }))
      .sort((a, b) => {
        // Sorts the data such that the oldest elements come first.
        return a.closeTime - b.closeTime;
      });

    // 5. Store results.
    this.historicalPricesHourly = newHistoricalPricesHourly;
  }

  async update() {
    const lastUpdateTime = this.lastUpdateTime;
    await this.updateLatest(lastUpdateTime);

    // User wants historical granularity at the minute interval, first try to update minute prices
    // and then try the hourly interval if the minute one fails. This is possible
    // because the minute lookback limit (2 days) is much shorter than the hourly one (2 months).
    // So the fallback to the hourly can return an approximate price (to the nearest hour) if
    // this.lookback > 2 days, or this `getHistoricalPrice` is called on a timestamp that
    // takes place over the weekend and therefore has missing data until the last weekday price.
    if (this.minuteLookback) {
      try {
        await this.updateMinute(lastUpdateTime);
      } catch (minuteError) {
        // Update should throw an error if historical prices cannot be updated for some reason,
        // which would cause a subsequent call to `getHistoricalPrice` to throw an error,
        // but in this case we'll check if an hourly interval fallback is specified,
        // and if so, only throw an error if both the minute and hourly timeseries
        // throw errors.
        if (this.hourlyLookback) {
          this.logger.debug({
            at: "TraderMade_PriceFeed#update",
            message: "updateMinute failed, falling back to updateHourly"
          });
          try {
            await this.updateHourly(lastUpdateTime);
          } catch (hourlyError) {
            this.logger.debug({
              at: "TraderMade_PriceFeed#update",
              message: "fallback to updateHourly also failed"
            });
            throw [minuteError, hourlyError];
          }
        } else {
          // No hourly fallback specified, throw error encountered when querying minute interval.
          throw minuteError;
        }
      }
    }

    // If `minuteLookback` is not specified but `hourlyLookback` is, then we'll
    // just update the hourly timeseries and throw an error if that fails.
    // Skip this update if hourlyPrices were already updated following an updateMinute
    // failure.
    if (!this.historicalPricesHourly && this.hourlyLookback) {
      await this.updateHourly(lastUpdateTime);
    }
  }

  _secondToDateTime(inputSecond) {
    return moment.unix(inputSecond).format("YYYY-MM-DD-HH:mm");
  }

  _dateTimeToSecond(inputDateTime) {
    return moment(inputDateTime, "YYYY-MM-DD HH:mm").unix();
  }
}

module.exports = {
  TraderMadePriceFeed
};
