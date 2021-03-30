const Token = artifacts.require("ExpandedERC20");

const { toBN } = web3.utils;

const CONSTANTS = {
  ETH_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
};

const assertBNGreaterThan = (a, b) => {
  const [aBN, bBN] = [a, b].map(x => toBN(x));
  assert.ok(aBN.gt(bBN), `${aBN.toString()} is not greater than ${bBN.toString()}`);
};

const getBalance = async ({ tokenAddress, userAddress }) => {
  if (tokenAddress === CONSTANTS.ETH_ADDRESS) {
    return web3.eth.getBalance(userAddress);
  }

  const erc20 = await Token.at(tokenAddress);
  return erc20.balanceOf.call(userAddress);
};

const oneInchSwapAndCheck = oneInch => async ({ fromToken, toToken, amountWei, userAddress }) => {
  const initialBal = await getBalance({ tokenAddress: toToken, userAddress });

  await oneInch.swap(
    {
      fromToken,
      toToken,
      amountWei
    },
    fromToken === CONSTANTS.ETH_ADDRESS ? { value: amountWei, from: userAddress } : { from: userAddress }
  );

  const finalBal = await getBalance({ tokenAddress: toToken, userAddress });

  assertBNGreaterThan(finalBal, initialBal);
};

module.exports = {
  assertBNGreaterThan,
  getBalance,
  oneInchSwapAndCheck,
  CONSTANTS
};
