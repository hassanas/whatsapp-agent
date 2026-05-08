import yaml
from langchain_openai import ChatOpenAI
from langchain_ollama import ChatOllama
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage

with open('../config.yaml') as f:
    cfg = yaml.safe_load(f)

def build_llm():
    if cfg['llm']['provider'] == 'openai':
        return ChatOpenAI(model=cfg['llm']['openai_model'], temperature=0.7)
    return ChatOllama(
        model=cfg['llm']['ollama_model'],
        base_url=cfg['llm']['ollama_base_url']
    )

llm = build_llm()

prompt = ChatPromptTemplate.from_messages([
    ("system", cfg['system_prompt']),
    MessagesPlaceholder(variable_name="history"),
    ("human", "{input}")
])

chain = prompt | llm

# In-memory sliding window history
history: list = []

def get_reply(text: str) -> str:
    global history
    response = chain.invoke({"input": text, "history": history})
    history.append(HumanMessage(content=text))
    history.append(AIMessage(content=response.content))
    # Keep only last N turns (each turn = 2 messages)
    max_messages = cfg['memory_window'] * 2
    if len(history) > max_messages:
        history = history[-max_messages:]
    return response.content