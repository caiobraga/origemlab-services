# Ollama em EC2 (IP fixo)

Stack CloudFormation: `infrastructure/ec2-ollama-server.yml`  
Workflow: `.github/workflows/deploy-ollama-server.yml`

## O que provisiona

- **EC2** com Ollama (`OLLAMA_HOST=0.0.0.0:11434`)
- **Elastic IP** estável — `OLLAMA_BASE_URL` não muda entre deploys dos outros serviços
- **SSM Session Manager** (sem abrir SSH na Internet)
- Disco **gp3** configurável (modelos ficam no volume)

Os **nomes** dos modelos (chat / embed) vêm das variáveis GitHub; o servidor só precisa ter os pesos (`ollama pull`). O workflow pode sincronizar modelos via SSM após cada deploy.

## Variáveis GitHub (origemlab-services)

| Variável | Obrigatória | Exemplo |
|----------|-------------|---------|
| `OLLAMA_SERVER_STACK_NAME` | sim | `origemlab-ollama` |
| `VPC_ID` | sim | mesma VPC dos tasks ECS |
| `OLLAMA_SERVER_SUBNET_ID` | sim | subnet com Internet (pública ou NAT) |
| `OLLAMA_CHAT_MODEL` | não | `qwen2.5:7b` |
| `OLLAMA_EMBED_MODEL` | não | `mxbai-embed-large:latest` |
| `OLLAMA_BASE_URL` | sim (outros workflows) | `http://3.xx.xx.xx:11434` (output do stack) |
| `OLLAMA_SERVER_INSTANCE_TYPE` | não | `t3.2xlarge`, `g5.2xlarge` |
| `OLLAMA_SERVER_ROOT_VOLUME_GB` | não | `150` |
| `OLLAMA_SERVER_ADDITIONAL_INGRESS_CIDR` | não | CIDR do EB se fora da VPC |
| `OLLAMA_SERVER_SSM_SYNC_MODELS` | não | `false` desliga pull automático no workflow |

Depois do primeiro deploy, copie o output **`OllamaBaseUrl`** para:

- `origemlab-services` → `OLLAMA_BASE_URL`
- `origemlab-backend` → `OLLAMA_BASE_URL` (+ `OLLAMA_MODEL`)

## Alterar modelos

1. Atualize `OLLAMA_CHAT_MODEL` / `OLLAMA_EMBED_MODEL` (e `OLLAMA_MODEL` no backend / pipelines).
2. Rode **deploy-ollama-server** (push no template ou `workflow_dispatch`).
3. O passo SSM faz `ollama pull` na instância existente **sem trocar o IP**.

Manual na instância:

```bash
aws ssm start-session --target <InstanceId>
sudo -i
source /opt/origemlab/ollama-models.env
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
systemctl restart ollama
```

## IAM (papel GitHub Actions)

Além das permissões ECS/CFN existentes, o papel precisa de algo como:

```json
{
  "Sid": "OrigemlabOllamaEc2",
  "Effect": "Allow",
  "Action": [
    "ec2:RunInstances",
    "ec2:TerminateInstances",
    "ec2:StartInstances",
    "ec2:StopInstances",
    "ec2:Describe*",
    "ec2:AllocateAddress",
    "ec2:ReleaseAddress",
    "ec2:AssociateAddress",
    "ec2:DisassociateAddress",
    "ec2:CreateSecurityGroup",
    "ec2:DeleteSecurityGroup",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:RevokeSecurityGroupIngress",
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:PassRole",
    "iam:CreateInstanceProfile",
    "iam:DeleteInstanceProfile",
    "iam:AddRoleToInstanceProfile",
    "iam:RemoveRoleFromInstanceProfile",
    "ssm:SendCommand",
    "ssm:GetCommandInvocation",
    "ssm:DescribeInstanceInformation"
  ],
  "Resource": "*"
}
```

## GPU

Use `OLLAMA_SERVER_INSTANCE_TYPE=g5.2xlarge` (ou maior) e, se necessário, `OLLAMA_SERVER_AMI_ID` com uma **Deep Learning AMI** que já traga drivers NVIDIA. O bootstrap usa o script oficial do Ollama em Amazon Linux 2023.
