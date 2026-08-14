// End-to-end example: LangChain.js agent using the tollbooth tools.
//
// Prereqs:
//   npm install @langchain/core @langchain/openai langchain zod
//   export OPENAI_API_KEY=...
//   export TOLLBOOTH_URL=http://127.0.0.1:8787
//   export TOLLBOOTH_API_KEY=tb_live_...   # optional
//   export XRPL_SEED=s...                    # required for x402
//
// Run: node exampleAgent.mjs

import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';

import { buildTollboothTools } from './tollboothTools.mjs';

const tools = await buildTollboothTools();
const llm = new ChatOpenAI({ model: 'gpt-4o', temperature: 0 });

const prompt = ChatPromptTemplate.fromMessages([
  ['system',
    'You are a Web3 security triage agent. Before letting the user interact '
    + 'with any address or contract, use the tollbooth tools to check risk. '
    + "Refuse (do not proceed) if risk_level is 'critical' or if reason_codes "
    + 'contains OFAC_SANCTIONED, KNOWN_EXPLOIT_MATCH, SELFDESTRUCT_INVOKED, or '
    + 'UNLIMITED_APPROVAL_GRANTED. Warn on SOURCE_UNVERIFIED, TX_REVERTED, or '
    + 'MULTIPLE_OUTBOUND_TOKEN_TRANSFERS but let the user decide. Cite reason '
    + 'codes in every response.'],
  ['human', '{input}'],
  new MessagesPlaceholder('agent_scratchpad'),
]);

const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools, verbose: true });

const result = await executor.invoke({
  input: 'Should I send 5 ETH to 0xdac17f958d2ee523a2206206994597c13d831ec7?',
});
console.log('\n=== Result ===');
console.log(result.output);
