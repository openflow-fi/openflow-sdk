#! /usr/bin/env node
const WebSocket = require("ws");
const executorAbi = require("../abi/executor.json");
const ReconnectingWebSocket = require("reconnecting-websocket");
const utils = require("./utils");
const { log } = utils;
const { ethers } = require("ethers");

const DEFAULT_EXECUTOR = "0x56cAFc730E3bb7C88Def17B8de585Bf1A253609D";
const AUTHENTICATE_ACTION = "authenticate";
const QUOTE_REQUEST_ACTION = "quoteRequest";
const QUOTE_RESPONSE_ACTION = "quoteResponse";
const QUOTE_ACCEPT_ACTION = "quoteAccept";
const ORDER_SUBMITTED_ACTION = "orderSubmitted";
const ORDER_FILLED_ACTION = "orderFilled";
const ACTIVE_QUOTES_ACTION = "activeQuotes";

const defaultRpcs = {
  250: "https://rpc.ankr.com/fantom",
  1: "https://rpc.ankr.com/eth",
  43114: "https://rpc.ankr.com/avalanche",
};

class Sdk {
  constructor({
    websocketUrl = "wss://solver.openflow.fi",
    executors,
    quoteHandler,
    fillHandler,
    rpcs,
    privateKey,
  }) {
    log("Openflow SDK initiated");
    this.websocketUrl = websocketUrl;
    this.quoteHandler = quoteHandler;
    this.fillHandler = fillHandler;
    this.executors = executors || {};
    this.rpcs = { ...defaultRpcs, ...rpcs };
    this.privateKey = privateKey;
  }

  getProvider(chainId) {
    const rpc = this.rpcs[chainId];
    if (!rpc) {
      log(
        `Missing RPC for chainId ${chainId}. To fix this add the RPC manually to the rpcs option object`
      );
      throw "Error in generateProviders()";
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    return provider;
  }

  getWallet(chainId) {
    const provider = this.getProvider(chainId);
    const wallet = new ethers.Wallet(this.privateKey, provider);
    return wallet;
  }

  async authenticate(authenticationPayload) {
    log("Authenticating...", authenticationPayload);
    this.client.sendJson({
      type: AUTHENTICATE_ACTION,
      payload: authenticationPayload,
    });
    return await this.client.waitForResponse(AUTHENTICATE_ACTION);
  }

  async respondToQuoteRequest(quote) {
    this.client.sendJson({
      type: QUOTE_RESPONSE_ACTION,
      payload: quote,
    });
  }

  async orderSubmitted(order) {
    this.client.sendJson({
      type: ORDER_SUBMITTED_ACTION,
      payload: order,
    });
  }

  async orderFilled({ order, transactionHash }) {
    log("Order filled", transactionHash);
    this.client.sendJson({
      type: ORDER_FILLED_ACTION,
      payload: { order, transactionHash },
    });
  }

  async generateTransaction(order, target, executorData) {
    if (target) {
      log("Generating transaction to target", target);
      order.data = utils.generateGenericSolverData({
        order,
        target,
        data: executorData,
      });
    }

    const { signature, message, data } = order;
    const args = {
      signature,
      multisig: "0x",
      data,
      payload: message,
    };

    const provider = this.getProvider(order.chainId);
    const executor = new ethers.Contract(
      DEFAULT_EXECUTOR,
      executorAbi,
      provider
    );
    const feeData = await provider.getFeeData();
    const { gasPrice } = feeData;

    const calldata = executor.interface.encodeFunctionData("executeOrder", [
      [args.signature, args.multisig, args.data, args.payload],
    ]);

    const gas = 8000000;
    const transaction = {
      to: executor,
      gasLimit: gas,
      gasPrice,
      data: calldata,
    };
    try {
      await provider.estimateGas(transaction);
      return transaction;
    } catch (err) {
      console.log(transaction);
      console.log("Transaction will fail", err.reason);
      return;
    }
  }

  async executeOrder(order, target, executorData) {
    const transaction = this.generateTransaction(order, target, executorData);
    if (!transaction) {
      return;
    }
    const wallet = this.getWallet(order.chainId);
    const walletTransaction = await wallet.populateTransaction(transaction);
    const signedTransaction = await wallet.signTransaction(walletTransaction);

    // Calculate transaction hash before sending
    const transactionHash = ethers.keccak256(signedTransaction);
    this.orderSubmitted({ transactionHash });

    // Submit transaction
    await wallet.sendTransaction(transaction).catch((err) => {
      log("Error sending transaction", err);
      return;
    });
    this.orderFilled({ order, transactionHash });
  }

  async connect(authPayload) {
    if (!authPayload) {
      if (!this.privateKey) {
        log(
          "Cannot authenticate. Please either provide a private key in options or generate an authentication payload and pass it to connect manually"
        );
        return;
      }
      authPayload = utils.generateAuthenticationPayload(this.privateKey);
    }

    log(`Connecting to ${this.websocketUrl}...`);
    const connectionPromise = (resolve) => {
      let client;
      client = new ReconnectingWebSocket(this.websocketUrl, [], {
        WebSocket: WebSocket,
        reconnectInterval: 1000,
      });
      client.pendingResponses = [];

      const processMessage = (message) => {
        const messageJson = JSON.parse(message.data);
        const { type, payload, error } = messageJson;
        log("Process message", messageJson);
        const pendingResponses = client.pendingResponses.filter(
          (response) => response.type === type
        );
        pendingResponses.forEach((response) => {
          if (type === AUTHENTICATE_ACTION) {
            if (error) {
              log("Authentication failed");
              return response.reject();
            }
            log(`Authentication successful for user: ${payload.address}`);
            return response.resolve();
          }
        });

        switch (type) {
          case QUOTE_REQUEST_ACTION:
            this.quoteHandler(messageJson.payload);
            break;
          case ACTIVE_QUOTES_ACTION:
            const quotes = messageJson.payload;
            quotes.forEach((quote) => {
              this.quoteHandler(quote);
            });
            break;
          case QUOTE_ACCEPT_ACTION:
            this.fillHandler(messageJson.payload);
            break;
          default:
            log("Received unhandled SDK solver message");
            break;
        }
      };

      client.sendJson = (message) => {
        client.send(JSON.stringify(message));
      };
      client.waitForResponse = async (type) => {
        return new Promise((resolve, reject) => {
          client.pendingResponses.push({
            type,
            resolve,
            reject,
          });
        });
      };
      client.addEventListener("message", processMessage);
      client.addEventListener("open", () => {
        this.authenticate(authPayload);
        resolve();
      });

      this.client = client;
    };
    return new Promise(connectionPromise);
  }
}

module.exports.Sdk = Sdk;
module.exports.utils = utils;
