// This module monitors the synthetic peg of a given expiring multiparty contract and reports when: 1) the synthetic is
// trading off peg 2) there is high volatility in the synthetic price or 3) there is high volatility in the reference price.

const { createFormatFunction, formatHours } = require("../common/FormattingUtils");
const { createObjectFromDefaultProps } = require("../common/ObjectUtils");

class SyntheticPegMonitor {
  /**
   * @notice Constructs new synthetic peg monitor module.
   * @param {Object} logger Winston module used to send logs.
   * @param {Object} web3 Instance of a web3 client provided by the class that initiates the monitor module.
   * @param {Object} uniswapPriceFeed Module used to query the current uniswap token price.
   * @param {Object} medianizerPriceFeed Module used to query the median price among selected price feeds.
   * @param {Object} [config] Contains fields with which constructor will attempt to override defaults.
   * @param {Object} empProps Configuration object used to inform logs of key EMP information. Example:
   *      { collateralCurrencySymbol: "DAI",
            syntheticCurrencySymbol:"ETHBTC",
            priceIdentifier: "ETH/BTC",
            networkId:1 }
   */
  constructor(logger, web3, uniswapPriceFeed, medianizerPriceFeed, config, empProps) {
    this.logger = logger;

    // Instance of price feeds used to check for deviation of synthetic token price.
    this.uniswapPriceFeed = uniswapPriceFeed;
    this.medianizerPriceFeed = medianizerPriceFeed;

    this.web3 = web3;

    // Contract constants including collateralCurrencySymbol, syntheticCurrencySymbol, priceIdentifier and networkId.
    this.empProps = empProps;

    this.formatDecimalString = createFormatFunction(this.web3, 2, 4);

    // Default config settings. SyntheticPegMonitor deployer can override these settings by passing in new
    // values via the `config` input object. The `isValid` property is a function that should be called
    // before resetting any config settings. `isValid` must return a Boolean.
    const defaultConfig = {
      deviationAlertThreshold: {
        // `deviationAlertThreshold`: Error threshold used to compare observed and expected token prices.
        // if the deviation in token price exceeds this value an alert is fired. If set to zero then fire no logs.
        value: 0.2,
        isValid: x => {
          return x < 100 && x >= 0;
        }
      },
      volatilityWindow: {
        // `volatilityWindow`: Length of time (in seconds) to snapshot volatility.
        value: 60 * 60, // 1 hour.
        isValid: x => {
          return x >= 0;
        }
      },
      volatilityAlertThreshold: {
        // `volatilityAlertThreshold`: Error threshold for pricefeed's price volatility over `volatilityWindow`.
        value: 0.05,
        isValid: x => {
          return x < 100 && x > 0;
        }
      }
    };
    Object.assign(this, createObjectFromDefaultProps(config, defaultConfig));

    // Helper functions from web3.
    this.toBN = this.web3.utils.toBN;
    this.toWei = this.web3.utils.toWei;
  }

  // Compares synthetic price on Uniswap with pegged price on medianizer price feed and fires a message
  // if the synythetic price deviates too far from the peg. If deviationAlertThreshold == 0 then do nothing.
  async checkPriceDeviation() {
    if (this.deviationAlertThreshold == 0) return; // return early if the threshold is zero.
    // Get the latest prices from the two price feeds.
    const uniswapTokenPrice = this.uniswapPriceFeed.getCurrentPrice();
    const cryptoWatchTokenPrice = this.medianizerPriceFeed.getCurrentPrice();

    if (!uniswapTokenPrice || !cryptoWatchTokenPrice) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Unable to get price",
        uniswapTokenPrice: uniswapTokenPrice ? uniswapTokenPrice.toString() : "N/A",
        cryptoWatchTokenPrice: cryptoWatchTokenPrice ? cryptoWatchTokenPrice.toString() : "N/A"
      });
      return;
    }

    this.logger.debug({
      at: "SyntheticPegMonitor",
      message: "Checking price deviation",
      uniswapTokenPrice: uniswapTokenPrice.toString(),
      cryptoWatchTokenPrice: cryptoWatchTokenPrice.toString()
    });

    const deviationError = this._calculateDeviationError(uniswapTokenPrice, cryptoWatchTokenPrice);
    // If the percentage error is greater than (gt) the threshold send a message.
    if (deviationError.abs().gt(this.toBN(this.toWei(this.deviationAlertThreshold.toString())))) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Synthetic off peg alert 😵",
        mrkdwn:
          "Synthetic token " +
          this.empProps.syntheticCurrencySymbol +
          " is trading at " +
          this.formatDecimalString(uniswapTokenPrice) +
          " on Uniswap. Target price is " +
          this.formatDecimalString(cryptoWatchTokenPrice) +
          ". Error of " +
          this.formatDecimalString(deviationError.muln(100)) + // multiply by 100 to make the error a percentage
          "%."
      });
    }
  }

  // Checks difference between minimum and maximum historical price over `volatilityWindow` amount of time.
  // Fires a message if the difference exceeds the `volatilityAlertThreshold` %.
  async checkPegVolatility() {
    const pricefeed = this.medianizerPriceFeed;

    const volData = await this._checkPricefeedVolatility(pricefeed);

    if (!volData) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Unable to get volatility data",
        pricefeed: "Medianizer"
      });
      return;
    }

    const pricefeedVolatility = volData.pricefeedVolatility;
    const pricefeedLatestPrice = volData.pricefeedLatestPrice;
    const min = volData.min;
    const max = volData.max;

    this.logger.debug({
      at: "SyntheticPegMonitor",
      message: "Checking peg price volatility",
      pricefeedVolatility: pricefeedVolatility.toString(),
      pricefeedLatestPrice: pricefeedLatestPrice.toString(),
      minPrice: min.toString(),
      maxPrice: max.toString()
    });

    // If the volatility percentage is greater than (gt) the threshold send a message.
    if (pricefeedVolatility.abs().gt(this.toBN(this.toWei(this.volatilityAlertThreshold.toString())))) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Peg price volatility alert 🌋",
        mrkdwn:
          "Latest updated " +
          this.empProps.priceIdentifier +
          " price is " +
          this.formatDecimalString(pricefeedLatestPrice) +
          ". Price moved " +
          this.formatDecimalString(pricefeedVolatility.muln(100)) +
          "% over the last " +
          formatHours(this.volatilityWindow) +
          " hour(s). Threshold is " +
          this.volatilityAlertThreshold * 100 +
          "%."
      });
    }
  }

  async checkSyntheticVolatility() {
    const pricefeed = this.uniswapPriceFeed;

    const volData = await this._checkPricefeedVolatility(pricefeed);

    if (!volData) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Unable to get volatility data",
        pricefeed: "Uniswap"
      });
      return;
    }

    const pricefeedVolatility = volData.pricefeedVolatility;
    const pricefeedLatestPrice = volData.pricefeedLatestPrice;
    const min = volData.min;
    const max = volData.max;

    this.logger.debug({
      at: "SyntheticPegMonitor",
      message: "Checking synthetic price volatility",
      pricefeedVolatility: pricefeedVolatility.toString(),
      pricefeedLatestPrice: pricefeedLatestPrice.toString(),
      minPrice: min.toString(),
      maxPrice: max.toString()
    });

    // If the volatility percentage is greater than (gt) the threshold send a message.
    if (pricefeedVolatility.abs().gt(this.toBN(this.toWei(this.volatilityAlertThreshold.toString())))) {
      this.logger.warn({
        at: "SyntheticPegMonitor",
        message: "Synthetic price volatility alert 🌋",
        mrkdwn:
          "Latest updated " +
          this.empProps.priceIdentifier +
          " price is " +
          this.formatDecimalString(pricefeedLatestPrice) +
          ". Price moved " +
          this.formatDecimalString(pricefeedVolatility.muln(100)) +
          "% over the last " +
          formatHours(this.volatilityWindow) +
          " hour(s). Threshold is " +
          this.volatilityAlertThreshold * 100 +
          "%."
      });
    }
  }

  // Return historical volatility for pricefeed over specified time range and latest price.
  async _checkPricefeedVolatility(pricefeed) {
    // Get all historical prices from `volatilityWindow` seconds before the last update time and
    // record the minimum and maximum.
    const latestTime = pricefeed.getLastUpdateTime();
    const volData = this._calculateHistoricalVolatility(pricefeed, latestTime, this.volatilityWindow);
    if (!volData) {
      return null;
    }

    // @dev: This is not `getCurrentTime` in order to enforce that the volatility calculation is counting back from precisely the
    // same timestamp as the "latest price". This would prevent inaccurate volatility readings where `currentTime` differs from `lastUpdateTime`.
    const pricefeedLatestPrice = pricefeed.getHistoricalPrice(latestTime);

    return {
      pricefeedVolatility: volData.volatility,
      pricefeedLatestPrice,
      min: volData.min,
      max: volData.max
    };
  }

  // Takes in two big numbers and returns the error between them. using: δ = (observed - expected) / expected
  // For example an observed price of 1.2 with an expected price of 1.0 will return (1.2 - 1.0) / 1.0 = 0.20
  // This is equivalent of a 20 percent deviation between the numbers.
  // Note that this logger can return negative error if the deviation is in a negative direction.
  _calculateDeviationError(observedValue, expectedValue) {
    return observedValue
      .sub(expectedValue)
      .mul(this.toBN(this.toWei("1"))) // Scale the numerator before division
      .div(expectedValue);
  }

  // Find difference between minimum and maximum prices for given pricefeed from `lookback` seconds in the past
  // until `mostRecentTime`. Returns volatility as (max - min)/min %. Also Identifies the direction volatility movement.
  _calculateHistoricalVolatility(pricefeed, mostRecentTime, lookback) {
    // Set max and min to latest price to start.
    let min = pricefeed.getHistoricalPrice(mostRecentTime);
    let max = min;
    if (!min || !max) return null;

    // Store the timestamp of the max and min value to infer the direction of the movement over the interval.
    let maxTimestamp = 0,
      minTimestamp = 0;
    // Iterate over all time series values to fine the maximum and minimum values.
    for (let i = 0; i < lookback; i++) {
      const timestamp = mostRecentTime - i;
      const _price = pricefeed.getHistoricalPrice(timestamp);
      if (!_price) {
        continue;
      }

      if (_price.lt(min)) {
        min = _price;
        minTimestamp = timestamp;
      }
      if (_price.gt(max)) {
        max = _price;
        maxTimestamp = timestamp;
      }
    }
    // If maxTimestamp < minTimestamp then positive volatility. If minTimestamp < maxTimestamp then negative volatility.
    // Note:this inequality intuitively feels backwards. This is because the for loop above itterates from the current
    // time back over the lookback duration rather than traversing time forwards from the lookback duration to present.
    const volatilityDirection = maxTimestamp < minTimestamp ? 1 : -1;

    // The min-max % calculation is identical to the equation in `_calculateDeviationError`.
    return {
      min: min,
      max: max,
      volatility: this._calculateDeviationError(max, min).mul(this.toBN(volatilityDirection))
    };
  }
}

module.exports = {
  SyntheticPegMonitor
};
