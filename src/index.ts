#!/usr/bin/env node

import {
	startNode,
	startCollator,
	killAll,
	generateChainSpec,
	generateChainSpecRaw,
	exportGenesisWasm,
	exportGenesisState,
	startSimpleCollator,
} from "./spawn";
import {
	connect,
	registerParachain,
	setBalance,
	establishHrmpChannel,
} from "./rpc";
import { checkConfig } from "./check";
import {
	clearAuthorities,
	addAuthority,
	changeGenesisConfig,
	addGenesisParachain,
} from "./spec";
import { parachainAccount } from "./parachain";
import { ApiPromise } from "@polkadot/api";

import { resolve, dirname } from "path";
import fs from "fs";
import { LaunchConfig, ParachainConfig } from "./types";

// Special care is needed to handle paths to various files (binaries, spec, config, etc...)
// The user passes the path to `config.json`, and we use that as the starting point for any other
// relative path. So the `config.json` file is what we will be our starting point.
const { argv } = require("yargs");

const config_file = argv._[0] ? argv._[0] : null;
if (!config_file) {
	console.error("Missing config file argument...");
	process.exit();
}
let config_path = resolve(process.cwd(), config_file);
let config_dir = dirname(config_path);
if (!fs.existsSync(config_path)) {
	console.error("Config file does not exist: ", config_path);
	process.exit();
}
let config: LaunchConfig = require(config_path);

function loadTypeDef(types: string | object): object {
	if (typeof types === "string") {
		// Treat types as a json file path
		try {
			const rawdata = fs.readFileSync(types, { encoding: "utf-8" });
			return JSON.parse(rawdata);
		} catch {
			console.error("failed to load parachain typedef file");
			process.exit(1);
		}
	} else {
		return types;
	}
}

// keep track of registered parachains
let registeredParachains: { [key: string]: boolean } = {};

async function main() {
	// Verify that the `config.json` has all the expected properties.
	if (!checkConfig(config)) {
		return;
	}

	const relay_chain_bin = resolve(config_dir, config.relaychain.bin);
	if (!fs.existsSync(relay_chain_bin)) {
		console.error("Relay chain binary does not exist: ", relay_chain_bin);
		process.exit();
	}
	const chain = config.relaychain.chain;
	await generateChainSpec(relay_chain_bin, chain);
	// -- Start Chain Spec Modify --
	clearAuthorities(`${chain}.json`);
	for (const node of config.relaychain.nodes) {
		await addAuthority(`${chain}.json`, node.name);
	}
	if (config.relaychain.runtime_genesis_config) {
		await changeGenesisConfig(
			`${chain}.json`,
			config.relaychain.runtime_genesis_config
		);
	}
	await addParachainsToGenesis(`${chain}.json`, config.parachains);
	// -- End Chain Spec Modify --
	await generateChainSpecRaw(relay_chain_bin, chain);
	const spec = resolve(`${chain}-raw.json`);

	// First we launch each of the validators for the relay chain.
	for (const node of config.relaychain.nodes) {
		const { name, wsPort, port, flags } = node;
		console.log(`Starting ${name}...`);
		// We spawn a `child_process` starting a node, and then wait until we
		// able to connect to it using PolkadotJS in order to know its running.
		startNode(relay_chain_bin, name, wsPort, port, spec, flags);
	}

	// Connect to the first relay chain node to submit the extrinsic.
	let relayChainApi: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	// Then launch each parachain
	for (const parachain of config.parachains) {
		const { id, balance, chain } = parachain;
		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		let account = parachainAccount(id);

		for (const node of parachain.nodes) {
			const { wsPort, port, flags } = node;
			console.log(
				`Starting a Collator for parachain ${id}: ${account}, Collator port : ${port} wsPort : ${wsPort}`
			);
			await startCollator(bin, id, wsPort, port, chain, spec, flags);
		}

		// Allow time for the TX to complete, avoiding nonce issues.
		// TODO: Handle nonce directly instead of this.
		if (balance) {
			await setBalance(relayChainApi, account, balance, config.finalization);
		}
	}

	// Then launch each simple parachain (e.g. an adder-collator)
	if (config.simpleParachains) {
		for (const simpleParachain of config.simpleParachains) {
			const { id, port, balance } = simpleParachain;
			const bin = resolve(config_dir, simpleParachain.bin);
			if (!fs.existsSync(bin)) {
				console.error("Simple parachain binary does not exist: ", bin);
				process.exit();
			}

			let account = parachainAccount(id);
			console.log(`Starting Parachain ${id}: ${account}`);
			await startSimpleCollator(bin, id, spec, port);

			// Get the information required to register the parachain on the relay chain.
			let genesisState;
			let genesisWasm;
			try {
				// adder-collator does not support `--parachain-id` for export-genesis-state (and it is
				// not necessary for it anyway), so we don't pass it here.
				genesisState = await exportGenesisState(bin);
				genesisWasm = await exportGenesisWasm(bin);
			} catch (err) {
				console.error(err);
				process.exit(1);
			}

			console.log(`Registering Parachain ${id}`);
			await registerParachain(
				relayChainApi,
				id,
				genesisWasm,
				genesisState,
				config.finalization
			);

			// Allow time for the TX to complete, avoiding nonce issues.
			// TODO: Handle nonce directly instead of this.
			if (balance) {
				await setBalance(relayChainApi, account, balance, config.finalization);
			}
		}
	}
	if (config.hrmpChannels) {
		for (const hrmpChannel of config.hrmpChannels) {
			console.log(
				`Setting Up HRMP Channel ${hrmpChannel.sender} -> ${hrmpChannel.recipient}`
			);
			await ensureOnboarded(relayChainApi, hrmpChannel.sender);
			await ensureOnboarded(relayChainApi, hrmpChannel.recipient);

			const { sender, recipient, maxCapacity, maxMessageSize } = hrmpChannel;
			await establishHrmpChannel(
				relayChainApi,
				sender,
				recipient,
				maxCapacity,
				maxMessageSize,
				config.finalization
			);
		}
	}
	console.log("🚀 POLKADOT LAUNCH COMPLETE 🚀");
}

async function ensureOnboarded(relayChainApi: ApiPromise, paraId: number) {
	return new Promise<void>(async function (resolve) {
		// We subscribe to the heads as a simple way to tell that the chain onboarded.
		let unsub = await relayChainApi.query.paras.heads(
			paraId,
			(response: any) => {
				if (response.isSome) {
					// Surprisingly, this ouroboros like subscription pattern seem to work.
					unsub();
					resolve();
				}
			}
		);
	});
}

async function addParachainsToGenesis(
	spec: string,
	parachains: ParachainConfig[]
) {
	console.log("\n⛓ Adding Genesis Parachains");
	for (const parachain of parachains) {
		const { id, chain } = parachain;
		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		// If it isn't registered yet, register the parachain in genesis
		if (!registeredParachains[id]) {
			// Get the information required to register the parachain in genesis.
			let genesisState;
			let genesisWasm;
			try {
				genesisState = await exportGenesisState(bin, id, chain);
				genesisWasm = await exportGenesisWasm(bin, chain);
			} catch (err) {
				console.error(err);
				process.exit(1);
			}

			await addGenesisParachain(spec, id, genesisState, genesisWasm, true);
			registeredParachains[id] = true;
		}
	}
}

// Kill all processes when exiting.
process.on("exit", function () {
	killAll();
});

// Handle ctrl+c to trigger `exit`.
process.on("SIGINT", function () {
	process.exit(2);
});

main();
