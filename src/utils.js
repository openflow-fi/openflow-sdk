const { ethers } = require("ethers");
const {
  SignTypedDataVersion,
  signTypedData,
} = require("@metamask/eth-sig-util");

const consoleLog = console.log;

class Utils {
  log() {
    let args = [];
    args.push("[openflow-sdk]");
    for (var argIdx = 0; argIdx < arguments.length; argIdx++) {
      args.push(arguments[argIdx]);
    }
    consoleLog.apply(console, args);
  }

  privateKeyToAddress(privateKey) {
    const createKeccakHash = require("keccak");
    const secp256k1 = require("secp256k1");
    const privateKeyBuffer = Buffer.from(privateKey, "hex");
    let pubKey = secp256k1.publicKeyCreate(privateKeyBuffer, false).slice(1);
    const address =
      "0x" +
      createKeccakHash("keccak256")
        .update(Buffer.from(pubKey))
        .digest()
        .slice(-20)
        .toString("hex");
    return address;
  }

  generateAuthenticationPayload(privateKey) {
    this.log("Generating authentication payload");
    const pkBuffer = Buffer.from(privateKey, "hex");
    const fromAddress = this.privateKeyToAddress(privateKey);
    const data = {
      types: {
        EIP712Domain: [],
      },
      primaryType: "EIP712Domain",
      message: {
        from: fromAddress,
      },
    };
    const version = SignTypedDataVersion.V4;
    const signature = signTypedData({
      privateKey: pkBuffer,
      data,
      version,
    });
    const payload = {
      data,
      signature,
      version,
    };
    return payload;
  }

  generateGenericSolverData({
    order: {
      message: { fromToken, toToken, fromAmount, toAmount, recipient },
    },
    toAmountOverride,
    target,
    data,
  }) {
    const frontPad = (data) =>
      `0x0000000000000000000000000000000000000000000000000000000000000020${data.substring(
        2
      )}`;

    const solverData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint", "uint", "address", "address", "bytes"],
      [
        fromToken,
        toToken,
        fromAmount,
        toAmountOverride.toString(),
        recipient,
        target,
        data,
      ]
    );
    return frontPad(solverData);
  }
}

module.exports = new Utils();
