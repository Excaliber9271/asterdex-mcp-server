#!/usr/bin/env node
/**
 * ScaleGrid CLI - Command line interface for testing and managing scaled grids
 */

import * as readline from 'readline';
import {
  calculateGridLevels,
  formatGridCalculation,
  validateConfig,
  mergeConfig,
  ScaleGridEngine,
  DEFAULT_CONFIG,
} from './scalegrid/index.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    ScaleGrid CLI Commands                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  preview <symbol> [price]   - Preview grid levels for a symbol    ║
║  calculate                  - Interactive grid calculator         ║
║  defaults                   - Show default configuration          ║
║  help                       - Show this help                      ║
║  exit                       - Exit CLI                            ║
╚═══════════════════════════════════════════════════════════════════╝
`);
}

function printDefaults() {
  console.log('\n📋 Default Configuration:');
  console.log('─'.repeat(40));
  Object.entries(DEFAULT_CONFIG).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
  console.log('');
}

async function previewGrid(symbol: string, entryPrice: number) {
  console.log(`\n🔍 Previewing grid for ${symbol} @ $${entryPrice}`);
  console.log('─'.repeat(50));

  const config = mergeConfig({
    symbol: symbol.toUpperCase(),
    baseOrderUsd: 10,
    rangePercent: 10,
    positionScale: 1.5,
    stepScale: 1.2,
    tpPercent: 2,
    maxPositionUsd: 200,
    maxDrawdownPercent: 15,
    maxRangePercent: 25,
    leverage: 10,
  });

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error('❌ Invalid config:', validation.errors.join(', '));
    return;
  }

  const calculation = calculateGridLevels(entryPrice, config);
  console.log(formatGridCalculation(calculation, config));
}

async function interactiveCalculator() {
  console.log('\n📊 Interactive Grid Calculator');
  console.log('─'.repeat(40));

  const symbol = await prompt('Symbol (e.g., BTCUSDT): ');
  const entryPrice = parseFloat(await prompt('Entry price ($): '));
  const baseOrderUsd = parseFloat(await prompt('Base order size ($) [10]: ') || '10');
  const rangePercent = parseFloat(await prompt('Range % [10]: ') || '10');
  const positionScale = parseFloat(await prompt('Position scale (1.0-2.5) [1.5]: ') || '1.5');
  const stepScale = parseFloat(await prompt('Step scale (1.0-2.0) [1.2]: ') || '1.2');
  const tpPercent = parseFloat(await prompt('TP % [2]: ') || '2');
  const maxPositionUsd = parseFloat(await prompt('Max position ($) [200]: ') || '200');
  const leverage = parseInt(await prompt('Leverage [10]: ') || '10');

  if (isNaN(entryPrice) || entryPrice <= 0) {
    console.error('❌ Invalid entry price');
    return;
  }

  const config = mergeConfig({
    symbol: symbol.toUpperCase() || 'BTCUSDT',
    baseOrderUsd,
    rangePercent,
    positionScale,
    stepScale,
    tpPercent,
    maxPositionUsd,
    maxDrawdownPercent: 15,
    maxRangePercent: 25,
    leverage,
  });

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error('❌ Invalid config:', validation.errors.join(', '));
    return;
  }

  const calculation = calculateGridLevels(entryPrice, config);
  console.log('\n' + formatGridCalculation(calculation, config));
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║           ScaleGrid CLI - Scaled Grid Trading System              ║
║                   Position Scaling Grid Trader                    ║
╚═══════════════════════════════════════════════════════════════════╝
`);
  printHelp();

  const args = process.argv.slice(2);

  // Handle direct command-line arguments
  if (args.length > 0) {
    const command = args[0].toLowerCase();

    if (command === 'preview' && args[1]) {
      const symbol = args[1];
      const price = parseFloat(args[2]) || 100;
      await previewGrid(symbol, price);
      rl.close();
      return;
    }

    if (command === 'defaults') {
      printDefaults();
      rl.close();
      return;
    }

    if (command === 'help') {
      printHelp();
      rl.close();
      return;
    }
  }

  // Interactive mode
  while (true) {
    const input = await prompt('\nscalegrid> ');
    const parts = input.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();

    if (!command) continue;

    switch (command) {
      case 'preview':
        if (!parts[1]) {
          console.log('Usage: preview <symbol> [price]');
          break;
        }
        await previewGrid(parts[1], parseFloat(parts[2]) || 100);
        break;

      case 'calculate':
      case 'calc':
        await interactiveCalculator();
        break;

      case 'defaults':
        printDefaults();
        break;

      case 'help':
      case '?':
        printHelp();
        break;

      case 'exit':
      case 'quit':
      case 'q':
        console.log('👋 Goodbye!');
        rl.close();
        process.exit(0);

      default:
        console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
