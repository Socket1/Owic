const { toWei, toBN } = web3.utils;
const winston = require("winston");
const sinon = require("sinon");
const { parseFixed } = require("@uma/common");

// Script to test
const { BalanceMonitor } = require("../src/BalanceMonitor");

// Helper client script and custom winston transport module to monitor winston log outputs
const {
  TokenBalanceClient,
  SpyTransport,
  lastSpyLogIncludes,
  lastSpyLogLevel
} = require("@uma/financial-templates-lib");

// Truffle artifacts
const Token = artifacts.require("ExpandedERC20");

// Run the tests against 3 diffrent price feed scaling combinations. Note these tests differ from the other monitor tests
// as the Balance monitor is only dependent on token balances feeds. No need to test price feed scaling decimals.
// 1) 18 decimal synthetic decimals with 18 decimal collateral decimals.
// 1) 18 decimal synthetic decimals with 8 decimal collateral decimals.
// 1) 8 decimal synthetic decimals with 18 decimal collateral decimals.
const configs = [
  { syntheticDecimals: 18, collateralDecimals: 18 },
  { syntheticDecimals: 18, collateralDecimals: 8 },
  { syntheticDecimals: 8, collateralDecimals: 18 }
];

const Convert = decimals => number => parseFixed(number.toString(), decimals).toString();

contract("BalanceMonitor.js", function(accounts) {
  for (const [index, testConfig] of configs.entries()) {
    describe(`${testConfig.collateralDecimals} collateral & ${testConfig.syntheticDecimals} synthetic decimals`, function() {
      // Note that we offset the accounts used in each test so they start with a full ether balance at the start.
      // This ensures the tests are decoupled.
      const tokenCreator = accounts[0 + index];
      const liquidatorBot = accounts[1 + index];
      const disputerBot = accounts[2 + index];

      // Contracts
      let collateralToken;
      let syntheticToken;

      // Test object for EMP event client
      let balanceMonitor;
      let tokenBalanceClient;
      let monitorConfig;
      let spy;
      let spyLogger;
      let empProps;

      let convertCollateral;
      let convertSynthetic;

      beforeEach(async function() {
        convertCollateral = Convert(testConfig.collateralDecimals);
        convertSynthetic = Convert(testConfig.syntheticDecimals);
        // Create new tokens for every test to reset balances of all accounts
        collateralToken = await Token.new("Wrapped Ether", "WETH", testConfig.collateralDecimals, {
          from: tokenCreator
        });
        await collateralToken.addMember(1, tokenCreator, { from: tokenCreator });
        syntheticToken = await Token.new("Test Synthetic Token", "SYNTH", testConfig.syntheticDecimals, {
          from: tokenCreator
        });
        await syntheticToken.addMember(1, tokenCreator, { from: tokenCreator });

        // Create a sinon spy and give it to the SpyTransport as the winston logger. Use this to check all winston
        // logs the correct text based on interactions with the emp. Note that only `info` level messages are captured.
        spy = sinon.spy(); // new spy per test to reset all counters and emited messages.
        spyLogger = winston.createLogger({
          level: "info",
          transports: [new SpyTransport({ level: "info" }, { spy: spy })]
        });
        tokenBalanceClient = new TokenBalanceClient(
          spyLogger,
          Token.abi,
          web3,
          collateralToken.address,
          syntheticToken.address
        );

        // Create two bot objects to monitor a liquidator bot with a lot of tokens and Eth and a disputer with less.
        monitorConfig = {
          botsToMonitor: [
            {
              name: "Liquidator bot",
              address: liquidatorBot,
              collateralThreshold: convertCollateral("10000"), // 10,000.00 tokens of collateral threshold
              syntheticThreshold: convertSynthetic("10000"), // 10,000.00 tokens of debt threshold
              etherThreshold: toWei("10")
            },
            {
              name: "Disputer bot",
              address: disputerBot,
              collateralThreshold: convertCollateral("500"), // 500.00 tokens of collateral threshold
              syntheticThreshold: convertSynthetic("100"), // 100.00 tokens of debt threshold
              etherThreshold: toWei("1")
            }
          ]
        };

        empProps = {
          collateralSymbol: await collateralToken.symbol(),
          syntheticSymbol: await syntheticToken.symbol(),
          collateralDecimals: testConfig.collateralDecimals,
          syntheticDecimals: testConfig.syntheticDecimals,
          networkId: await web3.eth.net.getId()
        };

        balanceMonitor = new BalanceMonitor({
          logger: spyLogger,
          tokenBalanceClient,
          config: monitorConfig,
          empProps
        });

        // setup the positions to the initial happy state.
        // Liquidator threshold is 10000 for both collateral and synthetic so mint a bit more to start above this
        await collateralToken.mint(liquidatorBot, convertCollateral("11000"), { from: tokenCreator });
        await syntheticToken.mint(liquidatorBot, convertSynthetic("11000"), { from: tokenCreator });

        // Disputer threshold is 500 and 100 for collateral and synthetics. mint collateral above this and synthetic at this
        await collateralToken.mint(disputerBot, convertCollateral("600"), { from: tokenCreator });
        await syntheticToken.mint(disputerBot, convertSynthetic("100"), { from: tokenCreator });
      });

      it("Correctly emits messages on token balances threshold", async function() {
        // Update the client.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        // The spy should not have been called. All positions are correctly funded and collateralized.
        assert.equal(spy.callCount, 0);

        // Transfer some tokens away from one of the monitored addresses and check that the bot correctly reports this.
        // Transferring 2000 tokens from the liquidatorBot brings its balance to 9000. this is below the 10000 threshold.
        await collateralToken.transfer(tokenCreator, convertCollateral("2000"), { from: liquidatorBot });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("9000"));
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        // The spy should be called exactly once. The most recent message should inform of the correct monitored position,
        // it's expected balance and and it's actual balance.
        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, `https://etherscan.io/address/${liquidatorBot}`)); // liquidator address
        assert.isTrue(lastSpyLogIncludes(spy, "collateral balance warning")); // Tx moved collateral. should emit accordingly
        assert.isFalse(lastSpyLogIncludes(spy, "synthetic balance warning")); // Synthetic was not moved. should not emit
        assert.isTrue(lastSpyLogIncludes(spy, "10,000.00")); // Correctly formatted number of threshold collateral
        assert.isTrue(lastSpyLogIncludes(spy, "9,000.00")); // Correctly formatted number of actual collateral
        assert.isTrue(lastSpyLogIncludes(spy, "WETH")); // Message should include the collateral currency symbol
        assert.equal(lastSpyLogLevel(spy), "warn");

        // Querying the balance again should emit a second message as the balance is still below the threshold.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 2);

        // Likewise a further drop in collateral should emit a new message.
        await collateralToken.transfer(tokenCreator, convertCollateral("2000"), { from: liquidatorBot });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("7000"));
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 3);

        // Dropping the synthetic below the threshold of the disputer should fire a message. The disputerBot's threshold
        // is set to 100e18, with a balance of 100e18 so moving just 1 wei units of synthetic should trigger an alert.
        // The liquidator bot is still below its threshold we should expect two messages to fire (total calls should be 3 + 2).
        await syntheticToken.transfer(tokenCreator, "1", { from: disputerBot });
        assert.equal(
          (await syntheticToken.balanceOf(disputerBot)).toString(),
          toBN(convertSynthetic("100"))
            .sub(toBN("1"))
            .toString()
        );

        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 5);
        assert.isTrue(lastSpyLogIncludes(spy, "Disputer bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, `https://etherscan.io/address/${disputerBot}`)); // disputer address
        assert.isFalse(lastSpyLogIncludes(spy, "collateral balance warning")); // collateral was not moved. should not emit
        assert.isTrue(lastSpyLogIncludes(spy, "synthetic balance warning")); // Tx moved synthetic. should emit accordingly
        assert.isTrue(lastSpyLogIncludes(spy, "100.00")); // Correctly formatted number of threshold Synthetic
        assert.isTrue(lastSpyLogIncludes(spy, "99.99")); // Correctly formatted number of Synthetic
        assert.isTrue(lastSpyLogIncludes(spy, "SYNTH")); // Message should include the Synthetic currency symbol
        assert.equal(lastSpyLogLevel(spy), "warn");
      });

      it("Correctly emits messages on ETH balance threshold", async function() {
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        // Test the ETH balance thresholding. Transfer enough Eth away from liquidatorBot should result in alert.
        const startLiquidatorBotETH = await web3.eth.getBalance(liquidatorBot);

        // Transfer the liquidator bot's eth balance - 5Eth such that irrespective of the value it ends with ~5 Eth (excluding gas cost).
        const amountToTransfer = toBN(startLiquidatorBotETH).sub(toBN(toWei("5")));
        await web3.eth.sendTransaction({
          from: liquidatorBot,
          to: tokenCreator,
          value: amountToTransfer.toString()
        });

        // After this transaction the liquidatorBot's ETH balance is below the threshold of 10Eth. The balance should be 5Eth,
        // minus the transaction fees. Thus strictly less than 5. This should emit an message.
        assert.isTrue(toBN(await web3.eth.getBalance(liquidatorBot)).lt(toBN(toWei("5"))));
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, `https://etherscan.io/address/${liquidatorBot}`)); // liquidator address
        assert.isTrue(lastSpyLogIncludes(spy, "Ether balance warning")); // Tx moved Ether. should emit accordingly
        assert.isFalse(lastSpyLogIncludes(spy, "synthetic balance warning")); // Synthetic was not moved. should not emit
        assert.isFalse(lastSpyLogIncludes(spy, "collateral balance warning")); // Collateral was not moved. should not emit
        assert.isTrue(lastSpyLogIncludes(spy, "10.00")); // Correctly formatted number of threshold collateral
        assert.isTrue(lastSpyLogIncludes(spy, "4.99")); // Correctly formatted number of actual number of Ether, rounded
        assert.isTrue(lastSpyLogIncludes(spy, "Ether")); // Message should include the collateral currency symbol
        assert.equal(lastSpyLogLevel(spy), "warn");

        // At the end of the test transfer back the eth to the liquidatorBot to clean up
        await web3.eth.sendTransaction({
          from: tokenCreator,
          to: liquidatorBot,
          value: amountToTransfer.toString()
        });
      });
      it("Correctly emit messages if balance moves above and below thresholds", async function() {
        // Update the client. No messages should be sent as above threshold values on all fronts.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 0);

        // Transfer tokens away from the liquidator below the threshold should emit a message
        await collateralToken.transfer(tokenCreator, convertCollateral("1001"), { from: liquidatorBot });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("9999"));
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, `https://etherscan.io/address/${liquidatorBot}`)); // liquidator address
        assert.isTrue(lastSpyLogIncludes(spy, "collateral balance warning")); // Tx moved collateral. should emit accordingly
        assert.isTrue(lastSpyLogIncludes(spy, "10,000.00")); // Correctly formatted number of threshold collateral
        assert.isTrue(lastSpyLogIncludes(spy, "9,999.00")); // Correctly formatted number of actual collateral
        assert.isTrue(lastSpyLogIncludes(spy, "WETH")); // Message should include the collateral currency symbol
        assert.equal(lastSpyLogLevel(spy), "warn");

        // Updating again should emit another message
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 2);

        // Transferring tokens back to the bot such that it's balance is above the threshold, updating the client and
        // transferring tokens away again should initiate a new message.
        await collateralToken.transfer(liquidatorBot, convertCollateral("11"), { from: tokenCreator });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("10010")); // balance above threshold
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 2); // No new event as balance above threshold

        await collateralToken.transfer(tokenCreator, convertCollateral("15"), { from: liquidatorBot });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("9995")); // balance below threshold

        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();
        assert.equal(spy.callCount, 3); // 1 new event as balance below threshold
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, `https://etherscan.io/address/${liquidatorBot}`)); // liquidator address
        assert.isTrue(lastSpyLogIncludes(spy, "collateral balance warning")); // Tx moved collateral. should emit accordingly
        assert.isTrue(lastSpyLogIncludes(spy, "10,000.00")); // Correctly formatted number of threshold collateral
        assert.isTrue(lastSpyLogIncludes(spy, "9,995.00")); // Correctly formatted number of actual collateral
        assert.isTrue(lastSpyLogIncludes(spy, "WETH")); // Message should include the collateral currency symbol
        assert.equal(lastSpyLogLevel(spy), "warn");
      });
      it("Cannot set invalid config", async function() {
        let errorThrown1;
        try {
          // Create an invalid config. A valid config expects an array of objects with keys in the object of `name` `address`
          // `syntheticThreshold`, `collateralThreshold`, `etherThreshold`. The value of `address` must be of type address.
          const invalidMonitorConfig1 = {
            // Config missing `name` and `syntheticThreshold`.
            botsToMonitor: [
              {
                address: liquidatorBot,
                collateralThreshold: convertCollateral("10000"), // 10,000.00 tokens of collateral threshold
                etherThreconvertSynthetic: toWei("10")
              }
            ]
          };

          balanceMonitor = new BalanceMonitor({
            logger: spyLogger,
            tokenBalanceClient,
            config: invalidMonitorConfig1,
            empProps
          });
          errorThrown1 = false;
        } catch (err) {
          errorThrown1 = true;
        }
        assert.isTrue(errorThrown1);

        let errorThrown2;
        try {
          // Create an invalid config. A valid config expects an array of objects with keys in the object of `name` `address`
          // `collateralThreshold`, `etherThreshold`. The value of `address` must be of type address.
          const invalidMonitorConfig2 = {
            // Config has an invalid address for the monitored bot.
            botsToMonitor: [
              {
                name: "Monitored liquidator bot",
                address: "INVALID_ADDRESS",
                collateralThreshold: convertCollateral("10000"), // 10,000.00 tokens of collateral threshold
                syntheticThreshold: convertSynthetic("10000"), // 10,000.00 tokens of debt threshold
                etherThreshold: toWei("10")
              }
            ]
          };

          balanceMonitor = new BalanceMonitor({
            logger: spyLogger,
            tokenBalanceClient,
            config: invalidMonitorConfig2,
            empProps
          });
          errorThrown2 = false;
        } catch (err) {
          errorThrown2 = true;
        }
        assert.isTrue(errorThrown2);
      });
      it("Can correctly create balance monitor and query balances with no config provided", async function() {
        const emptyConfig = {};
        let errorThrown;
        try {
          balanceMonitor = new BalanceMonitor({
            logger: spyLogger,
            tokenBalanceClient,
            config: emptyConfig,
            empProps
          });
          await balanceMonitor.checkBotBalances();
          errorThrown = false;
        } catch (err) {
          errorThrown = true;
        }
        assert.isFalse(errorThrown);
      });
      it("Can override the synthetic-threshold log level", async function() {
        const alertOverrideConfig = { ...monitorConfig, logOverrides: { syntheticThreshold: "error" } };
        balanceMonitor = new BalanceMonitor({
          logger: spyLogger,
          tokenBalanceClient,
          config: alertOverrideConfig,
          empProps
        });

        // Lower the liquidator bot's synthetic balance.
        await syntheticToken.transfer(tokenCreator, convertSynthetic("1001"), { from: liquidatorBot });
        assert.equal((await syntheticToken.balanceOf(liquidatorBot)).toString(), convertSynthetic("9999").toString());

        // Update monitors.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, "synthetic balance warning")); // Tx moved synthetic. should emit accordingly
        assert.equal(lastSpyLogLevel(spy), "error");
      });
      it("Can override the collateral-threshold log level", async function() {
        const alertOverrideConfig = { ...monitorConfig, logOverrides: { collateralThreshold: "error" } };
        balanceMonitor = new BalanceMonitor({
          logger: spyLogger,
          tokenBalanceClient,
          config: alertOverrideConfig,
          empProps
        });

        // Lower the liquidator bot's collateral balance.
        await collateralToken.transfer(tokenCreator, convertCollateral("1001"), { from: liquidatorBot });
        assert.equal((await collateralToken.balanceOf(liquidatorBot)).toString(), convertCollateral("9999").toString());

        // Update monitors.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, "collateral balance warning")); // Tx moved collateral. should emit accordingly
        assert.equal(lastSpyLogLevel(spy), "error");
      });
      it("Can override the ether-threshold log level", async function() {
        const alertOverrideConfig = { ...monitorConfig, logOverrides: { ethThreshold: "error" } };
        balanceMonitor = new BalanceMonitor({
          logger: spyLogger,
          tokenBalanceClient,
          config: alertOverrideConfig,
          empProps
        });

        // Lower the liquidator bot's ETH balance.
        const startLiquidatorBotETH = await web3.eth.getBalance(liquidatorBot);
        const amountToTransfer = toBN(startLiquidatorBotETH).sub(toBN(toWei("5")));
        await web3.eth.sendTransaction({
          from: liquidatorBot,
          to: tokenCreator,
          value: amountToTransfer.toString()
        });
        assert.isTrue(toBN(await web3.eth.getBalance(liquidatorBot)).lt(toBN(toWei("5"))));

        // Update monitors.
        await tokenBalanceClient.update();
        await balanceMonitor.checkBotBalances();

        assert.equal(spy.callCount, 1);
        assert.isTrue(lastSpyLogIncludes(spy, "Liquidator bot")); // name of bot from bot object
        assert.isTrue(lastSpyLogIncludes(spy, "Ether balance warning"));
        assert.equal(lastSpyLogLevel(spy), "error");
      });
    });
  }
});
