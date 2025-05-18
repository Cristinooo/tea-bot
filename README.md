require("dotenv").config();
const ethers = require("ethers");
const readline = require("readline");
const colors = require("colors");
const cliSpinners = require("cli-spinners");
const { HttpsProxyAgent } = require("https-proxy-agent");
const settings = require("./config/config");
const { showBanner } = require("./core/banner");
const fs = require("fs").promises;
const axios = require("axios");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, getRandomElement } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { solveCaptcha } = require("./captcha.js");

const wallets = loadData("wallets.txt");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const network = {
  name: "Tea Sepolia Testnet 🌐",
  rpc: "https://tea-sepolia.g.alchemy.com/public",
  chainId: 10218,
  symbol: "TEA",
  explorer: "https://sepolia.tea.xyz/",
};

// const erc20ABI = ["function balanceOf(address owner) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)", "function decimals() view returns (uint8)"];

const stTeaABI = ["function stake() payable", "function balanceOf(address owner) view returns (uint256)", "function withdraw(uint256 _amount)"];

const stTeaContractAddress = "0x04290DACdb061C6C9A0B9735556744be49A64012";

function parseProxy(proxy) {
  if (!proxy) return null;
  let proxyUrl = proxy;
  if (!proxy.startsWith("http://") && !proxy.startsWith("https://")) {
    proxyUrl = `http://${proxy}`;
  }
  return proxyUrl;
}

async function connectToNetwork(proxy, privateKey) {
  let wallet = null;
  try {
    const proxyUrl = parseProxy(proxy);
    let provider;
    if (proxyUrl && settings.USE_PROXY) {
      const agent = new HttpsProxyAgent(proxyUrl);
      provider = new ethers.providers.JsonRpcProvider({
        url: network.rpc,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        agent,
      });
    } else {
      provider = new ethers.providers.JsonRpcProvider(network.rpc);
    }
    wallet = new ethers.Wallet(privateKey, provider);
    return { provider, wallet, proxy };
  } catch (error) {
    console.error(colors.red(`[${wallet.address}] Connection error:`, error.message, "❌"));
    return { provider: null, wallet, proxy };
  }
}

async function askQuest(question) {
  return new Promise((resolve) => {
    rl.question(colors.yellow(`${question} `), (answer) => {
      resolve(answer);
    });
  });
}

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, authInfos) {
    this.baseURL = baseURL;
    this.baseURL_v2 = "";
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.wallet = new ethers.Wallet(this.itemData.privateKey);
    // this.w3 = new Web3(new Web3.providers.HttpProvider(settings.RPC_URL, proxy));
  }

  async log(msg, type = "info") {
    const accountPrefix = `[TEA][${this.accountIndex + 1}][${this.itemData.address}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      case "info":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async getWalletInfo(wallet, provider) {
    const address = wallet.address;
    const teaBalance = await provider.getBalance(address);
    const stTeaContract = new ethers.Contract(stTeaContractAddress, ["function balanceOf(address owner) view returns (uint256)"], wallet);
    const stTeaBalance = await stTeaContract.balanceOf(address).catch(() => ethers.BigNumber.from(0));

    this.log(colors.white(`TEA Balance: ${colors.cyan(ethers.utils.formatEther(teaBalance))} ${network.symbol} | stTEA Balance: ${colors.cyan(ethers.utils.formatEther(stTeaBalance))} stTEA `));
  }

  async stakeTea(wallet, percentage = 5, retries = 1) {
    percentage = getRandomNumber(settings.AMOUNT_STAKE[0], settings.AMOUNT_STAKE[1]); // Get a random percentage between 1 and 100
    percentage = Math.floor(percentage);

    if (percentage <= 0 || percentage > 100) {
      return console.log(colors.red(`Percentage: ${percentage}% | Invalid percentage. Please enter a value between 1 and 100. ⚠️`));
    }

    try {
      const balance = await wallet.provider.getBalance(wallet.address);
      const amount = balance.mul(percentage).div(100); // Calculate the amount based on the percentage
      const amountWei = ethers.utils.parseEther(ethers.utils.formatEther(amount)); // Convert to Wei
      const gasPrice = await wallet.provider.getGasPrice();
      const estimatedGas = settings.ESTIMATED_GAS || 100000;
      const gasCost = gasPrice.mul(estimatedGas); // gasCost in Wei

      const stTeaContract = new ethers.Contract(stTeaContractAddress, stTeaABI, wallet);

      this.log(`Gas cost (in Wei): ${gasCost.toString()}, Balance (in Wei): ${balance.toString()}, Estimated Gas: ${settings.ESTIMATED_GAS}`);

      // Compare gasCost and balance in Wei
      if (gasCost.add(amountWei).gt(balance)) {
        this.log(
          colors.red(
            `Gas cost: ${ethers.utils.formatEther(gasCost)} | Amount: ${ethers.utils.formatEther(amount)} | Balance: ${ethers.utils.formatEther(balance)} | Insufficient balance for gas fees. 🚫`
          )
        );
        return null;
      }

      this.log(colors.yellow(`Staking ${ethers.utils.formatEther(amount)} (${percentage}%) TEA...`));

      const tx = await stTeaContract.stake({
        value: amountWei,
        gasLimit: estimatedGas,
      });

      this.log(colors.white(`Transaction sent! Hash: ${colors.cyan(tx.hash)} 📤`));
      this.log(colors.gray(`View on explorer: ${network.explorer}/tx/${tx.hash} 🔗`));
      this.log("Waiting for confirmation...", "info");
      const receipt = await tx.wait();

      this.log(colors.green(`Transaction confirmed in block ${receipt.blockNumber} ✅ | Successfully staked ${ethers.utils.formatEther(amount)} TEA! 🎉`));

      return receipt;
    } catch (error) {
      this.log(colors.red("Error staking TEA:", error.message, "❌"));
      if (retries > 0) {
        this.log(colors.yellow(`Retrying stake... (${retries} retries left)`));
        return this.stakeTea(wallet, percentage, retries - 1);
      }
      return null;
    }
  }

  async withdrawTea(wallet) {
    try {
      const stTeaContract = new ethers.Contract(stTeaContractAddress, stTeaABI, wallet);

      // Get the user's stTEA balance
      const stTeaBalance = await stTeaContract.balanceOf(wallet.address);
      const amountWei = stTeaBalance.mul(80).div(100); // Calculate 80% of the stTEA balance

      const gasPrice = await wallet.provider.getGasPrice();
      const estimatedGas = settings.ESTIMATED_GAS || 100000; // Set a default estimated gas limit
      const gasCost = gasPrice.mul(estimatedGas); // gasCost in Wei
      const balance = await wallet.provider.getBalance(wallet.address);

      // Check if the user has enough stTEA to withdraw
      if (stTeaBalance.lt(amountWei)) {
        this.log(colors.red(`Insufficient stTEA balance. Available: ${ethers.utils.formatEther(stTeaBalance)} stTEA | Requested: ${ethers.utils.formatEther(amountWei)} stTEA 🚫`));
        return null;
      }

      // Check if the balance is sufficient for gas fees
      if (gasCost.gt(balance)) {
        this.log(colors.red(`Gas cost: ${ethers.utils.formatEther(gasCost)} | Balance: ${ethers.utils.formatEther(balance)} | Insufficient balance for gas fees. 🚫`));
        return null;
      }

      this.log(colors.yellow(`Withdrawing ${ethers.utils.formatEther(amountWei)} stTEA...`));

      const tx = await stTeaContract.withdraw(amountWei, {
        gasLimit: estimatedGas,
      });

      this.log(colors.white(`Transaction sent! Hash: ${colors.cyan(tx.hash)} 📤`));
      this.log(colors.gray(`View on explorer: ${network.explorer}/tx/${tx.hash} 🔗`));

      this.log("Waiting for confirmation...", "info");
      const receipt = await tx.wait();

      this.log(colors.green(`Transaction confirmed in block ${receipt.blockNumber} ✅ | Successfully withdrawn ${ethers.utils.formatEther(amountWei)} stTEA! 🎉`));

      return receipt;
    } catch (error) {
      this.log(colors.red("Error withdrawing TEA:", error.message, "❌"));
      return null;
    }
  }

  async claimRewards(wallet) {
    try {
      this.log(colors.yellow("Claiming stTEA rewards..."));

      const data = "0x3d18b912"; // This should be the correct method signature for claiming rewards
      const gasPrice = await wallet.provider.getGasPrice();
      const estimatedGas = 100000; // Set a default estimated gas limit
      const gasCost = gasPrice.mul(estimatedGas); // gas cost in Wei
      const balance = await wallet.provider.getBalance(wallet.address);

      // Check the total cost, here we assume no additional amount is needed to be sent
      const totalCost = gasCost; // Only gas cost is needed in this case

      // Check wallet balance
      if (balance.lt(totalCost)) {
        this.log(colors.red(`Insufficient balance. Available: ${ethers.utils.formatEther(balance)} TEA | Required: ${ethers.utils.formatEther(totalCost)} TEA 🚫`));
        return null;
      }

      const tx = await wallet.sendTransaction({
        to: stTeaContractAddress,
        data: data,
        gasLimit: estimatedGas,
      });

      this.log(colors.white(`Transaction sent! Hash: ${colors.cyan(tx.hash)} 📤`));
      this.log(colors.gray(`View on explorer: ${network.explorer}/tx/${tx.hash} 🔗`));

      this.log("Waiting for confirmation...", "info");
      const receipt = await tx.wait();

      this.log(colors.green(`Successfully claimed rewards! 🎉 | Transaction confirmed in block ${receipt.blockNumber} ✅`));

      return receipt;
    } catch (error) {
      this.log(colors.red("Error claiming rewards:", error.message, "❌"));
      return null;
    }
  }

  async sendToRandomAddress(wallet, amount, skipConfirmation = false) {
    try {
      const toAddress = getRandomElement(wallets);
      const amountWei = ethers.utils.parseEther(amount.toString());
      const gasPrice = await wallet.provider.getGasPrice();
      const estimatedGas = settings.ESTIMATED_GAS || 100000; // Set a default estimated gas limit
      const gasCost = gasPrice.mul(estimatedGas); // gas cost in Wei
      const totalCost = amountWei.add(gasCost); // total cost in Wei

      // Check wallet balance
      const balance = await wallet.provider.getBalance(wallet.address);
      if (balance.lt(totalCost)) {
        this.log(colors.red(`Insufficient balance. Available: ${ethers.utils.formatEther(balance)} TEA | Required: ${ethers.utils.formatEther(totalCost)} TEA 🚫`));
        return null;
      }

      this.log(colors.yellow(`Sending ${amount} TEA to random address: ${colors.cyan(toAddress)} 📤`));

      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: amountWei,
        gasLimit: estimatedGas,
      });

      this.log(colors.white(`Transaction sent! Hash: ${colors.cyan(tx.hash)} 🚀`));
      this.log(colors.gray(`View on explorer: ${network.explorer}/tx/${tx.hash} 🔗`));

      this.log("Waiting for confirmation...", "info");
      const receipt = await tx.wait();
      this.log(colors.green(`Transaction confirmed in block ${receipt.blockNumber} ✅`));

      return { receipt, toAddress };
    } catch (error) {
      this.log(colors.red("Error sending TEA:", error.message, "❌"));
      return null;
    }
  }

  async sendToAddress(wallet, amount, receiptAddress) {
    try {
      const toAddress = receiptAddress;
      const amountWei = ethers.utils.parseEther(amount.toString());
      const gasPrice = await wallet.provider.getGasPrice();
      const estimatedGas = settings.ESTIMATED_GAS || 100000; // Set a default estimated gas limit
      const gasCost = gasPrice.mul(estimatedGas); // gas cost in Wei
      const totalCost = amountWei.add(gasCost); // total cost in Wei

      // Check wallet balance
      const balance = await wallet.provider.getBalance(wallet.address);
      if (balance.lt(totalCost)) {
        this.log(colors.red(`Insufficient balance. Available: ${ethers.utils.formatEther(balance)} TEA | Required: ${ethers.utils.formatEther(totalCost)} TEA 🚫`));
        return null;
      }

      this.log(colors.yellow(`Sending ${amount} TEA to random address: ${colors.cyan(toAddress)} 📤`));

      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: amountWei,
        gasLimit: estimatedGas,
      });

      this.log(colors.white(`Transaction sent! Hash: ${colors.cyan(tx.hash)} 🚀`));
      this.log(colors.gray(`View on explorer: ${network.explorer}/tx/${tx.hash} 🔗`));

      this.log("Waiting for confirmation...", "info");
      const receipt = await tx.wait();
      this.log(colors.green(`Transaction confirmed in block ${receipt.blockNumber} ✅`));

      return { receipt, toAddress };
    } catch (error) {
      this.log(colors.red("Error sending TEA:", error.message, "❌"));
      return null;
    }
  }

  async executeRandomTransfers(wallet, numberOfTransfers) {
    this.log(colors.yellow(`Starting ${numberOfTransfers} transfers...\n`));

    const results = [];
    for (let i = 0; i < numberOfTransfers; i++) {
      const amount = getRandomNumber(settings.AMOUNT_TRANSFER[0], settings.AMOUNT_TRANSFER[1]);
      if (amount == 0) continue;
      this.log(colors.blue(`Transfer ${i + 1}/${numberOfTransfers} | Amount: ${amount} TEA`));
      const result = await this.sendToRandomAddress(wallet, amount, true);

      if (result) {
        results.push(result);
      }
      if (i < numberOfTransfers - 1) {
        const timeSleep = getRandomNumber(settings.DELAY_BETWEEN_REQUESTS[0], settings.DELAY_BETWEEN_REQUESTS[1]);
        this.log(colors.white(`Waiting for ${timeSleep} seconds before next transfer...`));
        await sleep(timeSleep);
      }
    }
    this.log(colors.green(`\nCompleted ${results.length}/${numberOfTransfers} transfers successfully. 🎉`));
    return results;
  }

  async executeTransfers(wallet, numberOfTransfers) {
    this.log(colors.yellow(`Starting ${numberOfTransfers} transfers...\n`));

    const results = [];
    for (let i = 0; i < numberOfTransfers; i++) {
      const amount = getRandomNumber(settings.AMOUNT_TRANSFER[0], settings.AMOUNT_TRANSFER[1]);
      if (amount == 0) continue;
      this.log(colors.blue(`Transfer ${i + 1}/${numberOfTransfers} | Amount: ${amount} TEA`));
      const result = await this.sendToAddress(wallet, amount, wallets[i]);

      if (result) {
        results.push(result);
      }
      if (i < numberOfTransfers - 1) {
        const timeSleep = getRandomNumber(settings.DELAY_BETWEEN_REQUESTS[0], settings.DELAY_BETWEEN_REQUESTS[1]);
        this.log(colors.white(`Waiting for ${timeSleep} seconds before next transfer...`));
        await sleep(timeSleep);
      }
    }
    this.log(colors.green(`\nCompleted ${results.length}/${numberOfTransfers} transfers successfully. 🎉`));
    return results;
  }

  async executeDailyTask(wallet) {
    const numberOfTransfers = settings.NUMBER_OF_TRANSFER;
    await this.executeRandomTransfers(wallet, numberOfTransfers);
  }

  async handleTransfers(wallet) {
    await this.executeTransfers(wallet, wallets.length);
  }

  async handleStaking(wallet) {
    let amount = getRandomNumber(settings.AMOUNT_STAKE[0], settings.AMOUNT_STAKE[1]);
    await this.stakeTea(wallet, amount);
  }

  async handleWithdrawing(wallet) {
    await this.withdrawTea(wallet);
  }

  async handleClaiming(wallet) {
    await this.claimRewards(wallet);
  }

  async handleDailyTask(wallet) {
    await this.executeDailyTask(wallet);
  }

  async handleFaucet() {
    try {
      this.log(`Starting faucet...`, "info");
      const address = this.itemData.address;
      this.log(`Captcha solving[1/2]...`, "info");
      const captchaToken = await solveCaptcha();
      if (!captchaToken) {
        this.log(`failed to solve captcha`, "error");
        return;
      }

      if (!this.proxy) {
        this.log(`Proxy not found`, "error");
        return;
      }
      const agent = new HttpsProxyAgent(this.proxy);
      // Request 1: startSession
      const urlStart = `https://faucet-sepolia.tea.xyz/api/startSession?cliver=${settings.CLIVER}`;
      const payloadStart = {
        addr: address,
        captchaToken: captchaToken,
      };
      const headers = {
        "Content-Type": "application/json",
      };

      const responseStart = await axios.post(urlStart, payloadStart, {
        headers: headers,
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 120000,
      });

      if (responseStart.status !== 200) {
        this.log(`Error starting session: ${responseStart.status} - ${JSON.stringify(responseStart?.data || {})}`, "error");
        return;
      }

      // Lấy session từ response
      const startData = responseStart.data;
      const session = startData.session;
      if (!session) {
        this.log(`Cannot get session`, "error");
        return;
      }

      // Giải hCaptcha_claim
      this.log(`Captcha solving[2/2]...`, "info");
      const captchaTokenClaim = await solveCaptcha();
      if (!captchaTokenClaim) {
        this.log(`failed to solve captcha`, "error");
        return;
      }

      // Request 2: claimReward
      const urlClaim = "https://faucet-sepolia.tea.xyz/api/claimReward";
      const payloadClaim = {
        session: session,
        captchaToken: captchaTokenClaim,
      };

      const responseClaim = await axios.post(urlClaim, payloadClaim, {
        headers: headers,
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 120000,
      });

      if (responseClaim.status !== 200) {
        this.log(`Error claiming reward: ${responseClaim.status} - ${JSON.stringify(responseClaim?.data || {})}`, "error");
        return;
      }

      // Lấy dữ liệu từ response claim
      const claimData = responseClaim.data;
      const claimIdx = claimData.claimIdx;
      const claimStatus = claimData.claimStatus;
      const successMsg = `Claim Idex: ${claimIdx} | Status: ${claimStatus} (Pending)`;
      this.log(successMsg, "success");
    } catch (error) {
      this.log(`Error in handleFaucet: ${error.message}`, "error");
    }
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.address;
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const { provider, wallet, proxy } = await connectToNetwork(this.proxy, this.itemData.privateKey);

    if (!provider) {
      this.log("Failed to connect to network. Exiting...", "error");
      return;
    }

    await this.getWalletInfo(wallet, provider, proxy);

    switch (this.itemData.acction) {
      case "1":
        await this.handleTransfers(wallet);
        break;
      case "2":
        await this.handleStaking(wallet);
        break;
      case "3":
        await this.handleClaiming(wallet);
        break;
      case "4":
        await this.handleWithdrawing(wallet);
        break;
      case "5":
        await this.handleDailyTask(wallet);
        break;
      case "6":
        await this.handleFaucet();
        break;
      default:
        process.exit(0);
    }

    await this.getWalletInfo(wallet, provider, proxy);
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI = null, authInfos } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, authInfos);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  showBanner();
  const privateKeys = loadData("privateKeys.txt");
  const proxies = loadData("proxies.txt");
  let acction = 0;
  if (privateKeys.length == 0 || (privateKeys.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${privateKeys.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  console.log(colors.white("\n===== MAIN MENU ====="));
  console.log(colors.white("1. Send TEA to random addresses in wallets.txt (share TEA)"));
  console.log(colors.white("2. Stake TEA"));
  console.log(colors.white("3. Claim rewards"));
  console.log(colors.white("4. Withdraw stTEA (Unstake: 80%)"));
  console.log(colors.white("5. Daily task (100 transfers)"));
  console.log(colors.white("6. Faucet TEA | Wallets from privateKeys.txt"));
  console.log(colors.white("===================="));

  acction = await askQuest("Choose an option (1-6): ");
  if (acction < 1 || acction > 6) {
    console.log(colors.red("Invalid option. Please try again. ⚠️"));
    process.exit(0);
  }

  const data = privateKeys.map((val, index) => {
    const prvk = val.startsWith("0x") ? val : `0x${val}`;
    const wallet = new ethers.Wallet(prvk);
    const item = {
      address: wallet.address,
      privateKey: prvk,
      index,
      acction,
    };
    return item;
  });

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: null,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
            authInfos: {},
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error?.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản`.magenta);
    showBanner();
    await sleep(1);
    process.exit(0);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}