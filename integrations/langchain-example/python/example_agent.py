"""End-to-end example: LangChain agent using the tollbooth tools.

Prereqs:
    pip install langchain langchain-openai langchain-core requests
    export OPENAI_API_KEY=...
    export TOLLBOOTH_URL=http://127.0.0.1:8787
    export TOLLBOOTH_API_KEY=tb_live_...    # optional, only for verify-poc + auth-ping
    export XRPL_SEED=s...                    # required for x402 endpoints

Run:
    python example_agent.py
"""
from __future__ import annotations

from langchain.agents import AgentExecutor, create_openai_functions_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

from tollbooth_tools import build_tollbooth_tools


def main() -> None:
    tools = build_tollbooth_tools()
    llm = ChatOpenAI(model="gpt-4o", temperature=0)

    prompt = ChatPromptTemplate.from_messages([
        ("system",
         "You are a Web3 security triage agent. Before letting the user "
         "interact with any address or contract, use the tollbooth tools to "
         "check risk. Refuse (do not proceed) if risk_level is 'critical' "
         "or if reason_codes contains OFAC_SANCTIONED, KNOWN_EXPLOIT_MATCH, "
         "SELFDESTRUCT_INVOKED, or UNLIMITED_APPROVAL_GRANTED. Warn on "
         "SOURCE_UNVERIFIED, TX_REVERTED, or MULTIPLE_OUTBOUND_TOKEN_TRANSFERS "
         "but let the user decide. Cite reason codes in every response."),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    agent = create_openai_functions_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    # Example 1: wallet risk (x402-paid).
    result = executor.invoke({
        "input": "Should I send 5 ETH to 0xdac17f958d2ee523a2206206994597c13d831ec7?"
    })
    print("\n=== Result ===")
    print(result["output"])


if __name__ == "__main__":
    main()
