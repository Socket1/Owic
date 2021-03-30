require("dotenv").config();
const chalkPipe = require("chalk-pipe");
const boldUnderline = chalkPipe("bold.underline");
const boldUnderlineRed = chalkPipe("bold.underline.red");

const { Logger } = require("../financial-templates-lib/logger/Logger");
const winston = require("winston");

const { createPriceFeed } = require("../financial-templates-lib/price-feed/CreatePriceFeed");
const { Networker } = require("../financial-templates-lib/price-feed/Networker");

// Clients to retrieve on-chain data.
const { ExpiringMultiPartyClient } = require("../financial-templates-lib/clients/ExpiringMultiPartyClient");
const { ExpiringMultiPartyEventClient } = require("../financial-templates-lib/clients/ExpiringMultiPartyEventClient");
const { TokenBalanceClient } = require("../financial-templates-lib/clients/TokenBalanceClient");

// DVM utils.
const { interfaceName } = require("../core/utils/Constants");

const { SponsorReporter } = require("./SponsorReporter");
const { GlobalSummaryReporter } = require("./GlobalSummaryReporter");

// Truffle contracts
const ExpiringMultiParty = artifacts.require("ExpiringMultiParty");
const ExpandedERC20 = artifacts.require("ExpandedERC20");
const OracleInterface = artifacts.require("OracleInterface");
const Finder = artifacts.require("Finder");

async function run(
  address,
  walletsToMonitor,
  referencePriceFeedConfig,
  uniswapPriceFeedConfig,
  periodLengthSeconds,
  endDateOffsetSeconds
) {
  console.log(boldUnderlineRed("Starting Reporter Script🖨\n"));

  // For now we will use a dummy transport to make things quiet in the logs
  const dummyLogger = winston.createLogger({
    level: "error",
    transports: [new winston.transports.Console()]
  });

  const emp = await ExpiringMultiParty.at(address);
  const collateralTokenAddress = await emp.collateralCurrency();
  const collateralToken = await ExpandedERC20.at(collateralTokenAddress);
  const syntheticTokenAddress = await emp.tokenCurrency();
  const syntheticToken = await ExpandedERC20.at(syntheticTokenAddress);

  // Generate EMP properties to inform monitor modules of important info like token symbols and price identifier.
  const empProps = {
    collateralCurrencySymbol: await collateralToken.symbol(),
    syntheticCurrencySymbol: await syntheticToken.symbol(),
    priceIdentifier: web3.utils.hexToUtf8(await emp.priceIdentifier()),
    networkId: await web3.eth.net.getId()
  };

  // 1. EMP client for getting position information and ecosystem stats.
  const empClient = new ExpiringMultiPartyClient(dummyLogger, ExpiringMultiParty.abi, web3, emp.address, 10);

  // 2a. Reference price feed for calculating "actual" positions CR ratios.
  const getTime = () => Math.round(new Date().getTime() / 1000);
  const referencePriceFeed = await createPriceFeed(
    dummyLogger,
    web3,
    new Networker(dummyLogger),
    getTime,
    referencePriceFeedConfig
  );

  // 2b. Uniswap price feed for calculating synthetic token trading stats.
  const uniswapPriceFeed = await createPriceFeed(
    dummyLogger,
    web3,
    new Networker(dummyLogger),
    getTime,
    uniswapPriceFeedConfig
  );

  // 3. EMP event client for reading past events.
  const startBlock = 0;
  const empEventClient = new ExpiringMultiPartyEventClient(
    dummyLogger,
    ExpiringMultiParty.abi,
    web3,
    emp.address,
    startBlock
  );

  // 4. Oracle contract for fetching EMP dispute resolution prices.
  const finder = await Finder.deployed();
  const oracle = await OracleInterface.at(
    await finder.getImplementationAddress(web3.utils.utf8ToHex(interfaceName.Oracle))
  );

  // 5. Token balance client for getting monitored wallets balances.
  const tokenBalanceClient = new TokenBalanceClient(
    Logger,
    ExpandedERC20.abi,
    web3,
    collateralTokenAddress,
    syntheticTokenAddress,
    10
  );

  // 6. Sponsor reporter to generate metrics on monitored positions.
  const sponsorReporter = new SponsorReporter(
    empClient,
    tokenBalanceClient,
    walletsToMonitor,
    referencePriceFeed,
    empProps
  );

  // 7. Global summary reporter reporter to generate EMP wide metrics.
  const globalSummaryReporter = new GlobalSummaryReporter(
    empClient,
    empEventClient,
    referencePriceFeed,
    uniswapPriceFeed,
    oracle,
    collateralToken,
    syntheticToken,
    endDateOffsetSeconds,
    periodLengthSeconds
  );

  console.log(boldUnderline("1. Monitored wallets risk metrics🔎"));
  await sponsorReporter.generateMonitoredWalletMetrics();

  console.log(boldUnderline("2. Sponsor table💸"));
  await sponsorReporter.generateSponsorsTable();

  console.log(boldUnderline("3. Global summary stats🌎"));
  await globalSummaryReporter.generateSummaryStatsTable();
}

async function Poll(callback) {
  try {
    if (
      !process.env.EMP_ADDRESS ||
      !process.env.WALLET_MONITOR_OBJECT ||
      !process.env.PRICE_FEED_CONFIG ||
      !process.env.UNISWAP_PRICE_FEED_CONFIG
    ) {
      throw "Bad setup! Must specify EMP_ADDRESS, WALLET_MONITOR_OBJECT, PRICE_FEED_CONFIG, and UNISWAP_PRICE_FEED_CONFIG";
    }

    // Address of the expiring multi party client on the given network.
    const empAddress = process.env.EMP_ADDRESS;

    // Array of object describing the wallets to generate stats on. Example:
    // WALLET_MONITOR_OBJECT=[{"name":"My sponsor wallet","address":"0x367...afb"},...]
    const walletsToMonitor = JSON.parse(process.env.WALLET_MONITOR_OBJECT);

    // Configuration for price feed objects. Example:
    // PRICE_FEED_CONFIG={"type":"medianizer","pair":"ethbtc","lookback":7200,"minTimeBetweenUpdates":60,"medianizedFeeds":[{"type":"cryptowatch","exchange":"coinbase-pro"}]}
    const referencePriceFeedConfig = JSON.parse(process.env.PRICE_FEED_CONFIG);
    // UNISWAP_PRICE_FEED_CONFIG={"type":"uniswap","twapLength":86400,"lookback":7200,"invertPrice":true,"uniswapAddress":"0x1e4F65138Bbdb66b9C4140b2b18255A896272338"}
    const uniswapPriceFeedConfig = JSON.parse(process.env.UNISWAP_PRICE_FEED_CONFIG);

    // The report will always display "cumulative" and "current" data but it will also show data for a shorter period ("period") whose
    // start and end dates we can control:

    // Change `endDateOffsetSeconds` to modify the end date for the "period". End date will be (now - endDateOffsetSeconds).
    const endDateOffsetSeconds = process.env.PERIOD_END_DATE_OFFSET ? parseInt(process.env.PERIOD_END_DATE_OFFSET) : 0;

    // Change `periodLengthSeconds` to modify the "period" start date. Start date will be (endDate - periodLengthSeconds).
    const periodLengthSeconds = process.env.PERIOD_REPORT_LENGTH
      ? parseInt(process.env.PERIOD_REPORT_LENGTH)
      : 24 * 60 * 60;

    await run(
      empAddress,
      walletsToMonitor,
      referencePriceFeedConfig,
      uniswapPriceFeedConfig,
      periodLengthSeconds,
      endDateOffsetSeconds
    );
    callback();
  } catch (err) {
    callback(err);
  }
}

// Attach this function to the exported function
// in order to allow the script to be executed through both truffle and a test runner.
Poll.run = run;
module.exports = Poll;