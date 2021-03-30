// Read in a json file containing information for a particular window distribution and produce a claims file containing
// merkle proofs and a merkle root. This input file is produced from the liquidity/developer/KPI outputs output scripts.
// The output of this script is then fed into the PublishClaimsForWindow.ts script to add claims to IPFS and Ethereum.

// The input file should implement the following formatting:
// {
// "chainId": 42,
// "rewardToken": "0x47B1EE6d02af0AA5082C90Ea1c2c14c70399186c",
// "windowIndex": 0,
// "totalRewardsDistributed": "15000000000000000000",
// "windowStart": 1614850539,
// "recipients": {
//   "0x00b591bc2b682a0b30dd72bac9406bfa13e5d3cd": {
//     "amount": "1000000000000000000",
//     "metaData": { "reason": ["YD-WETH-21 Liquidity Mining Week 27"] }
//   }... for all recipients
// }

// example execution: ts-node ./scripts/1_CreateClaimsForWindow.ts -i ./scripts/example.json

const assert = require("assert");
const path = require("path");
import { program } from "commander";
import fs from "fs";
const { getWeb3 } = require("@uma/common");
const web3 = getWeb3();
const { toBN } = web3.utils;

import MerkleDistributorHelper = require("../src/MerkleDistributorHelper");

program
  .requiredOption("-i, --input <path>", "input JSON file location containing a recipients payout")
  .parse(process.argv);

const options = program.opts();

const recipientsObject = JSON.parse(fs.readFileSync(options.input, { encoding: "utf8" }));

// We can't easily do runtime verification of JSON file types in typescript. We could use a JSON scheme, but to keep
// things simple for now we can just double check that some important keys are present within the JSON file.
if (typeof recipientsObject !== "object") throw new Error("Invalid JSON");
const expectedKeys = ["chainId", "rewardToken", "windowIndex", "totalRewardsDistributed", "windowStart", "recipients"];
expectedKeys.forEach(expectedKey => {
  if (!Object.keys(recipientsObject).includes(expectedKey)) {
    throw new Error(`recipients object missing expected key: ${expectedKey}`);
  }
});

async function main() {
  console.log("Running claims creation script 🧞‍♂️");

  // Do some basic sanity checks. In particular, verify that totalRewardsDistributed equals the sum of all amounts.
  let totalCalculatedRewards = toBN("0");
  Object.keys(recipientsObject.recipients).forEach((recipientAddress: any) => {
    totalCalculatedRewards = totalCalculatedRewards.add(toBN(recipientsObject.recipients[recipientAddress].amount));
  });
  assert(totalCalculatedRewards.toString() == recipientsObject.totalRewardsDistributed, "Wrong total rewards");

  // Generate the merkle proofs for each recipient & the merkle root of the tree.
  const { recipientsDataWithProof, merkleRoot } = MerkleDistributorHelper.createMerkleDistributionProofs(
    recipientsObject.recipients,
    recipientsObject.windowIndex
  );

  // Append the merkleRoot & claims recipientsDataWithProof to a new output format
  const outputData: any = {
    chainId: recipientsObject.chainId,
    rewardToken: recipientsObject.rewardToken,
    windowIndex: recipientsObject.windowIndex,
    totalRewardsDistributed: recipientsObject.totalRewardsDistributed,
    windowStart: recipientsObject.windowStart,
    merkleRoot,
    claims: recipientsDataWithProof
  };

  // Save the file to disk.
  const savePath = `${path.resolve(__dirname)}/../proof-files/chain-id-${recipientsObject.chainId}-reward-window-${
    recipientsObject.windowIndex
  }-claims-file.json`;
  fs.writeFileSync(savePath, JSON.stringify(outputData));
  console.log("🗄  File successfully written to", savePath);
}

main();
