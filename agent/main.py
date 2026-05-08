from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict
from llm_chain import get_reply
import yaml, uvicorn

with open('../config.yaml') as f:
    cfg = yaml.safe_load(f)

app = FastAPI()

class Msg(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    body: str

@app.post('/message')
async def handle(msg: Msg):
    if not msg.body.strip():
        raise HTTPException(400, 'Empty message')
    return {'reply': get_reply(msg.body)}

if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=cfg['agent_port'])