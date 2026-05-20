# Ollama em EC2 (legado — IP fixo)

> **Recomendado:** [`../ollama-service/README.md`](../ollama-service/README.md) — ECS Fargate + NLB (`http://origemlab-ollama-nlb-312422980eebe2d0.elb.us-east-1.amazonaws.com:11434`).

Stack CloudFormation: `infrastructure/ec2-ollama-server.yml`  
Workflow: `.github/workflows/deploy-ollama-server.yml` (só manual)

## Se o stack `origemlab-ollama` falhar

1. No log do GitHub Actions, abra o grupo **Recent stack events** (motivo exato).
2. Causas comuns:
   - **IAM role já existe** após deploy anterior (`origemlab-ollama-ec2-origemlab-ollama`) → apague o stack em `ROLLBACK_COMPLETE` ou o role órfão no IAM e rode de novo.
   - **Subnet fora da VPC** (`VPC_ID` ≠ VPC da subnet) → use subnet da mesma VPC dos tasks ECS.
   - **Subnet privada sem NAT** → use subnet **pública** (`MapPublicIpOnLaunch`) ou defina `OLLAMA_SERVER_SUBNET_ID` para uma subnet pública.
   - **Limite de EIP** na conta → liberte EIPs não usados.
3. Console: CloudFormation → stack `origemlab-ollama` → aba **Events**.

## O que provisiona

- **EC2** com Ollama (`OLLAMA_HOST=0.0.0.0:11434`)
- **Elastic IP** estável — `OLLAMA_BASE_URL` não muda entre deploys dos outros serviços
- **SSM Session Manager** (sem abrir SSH na Internet)
- Disco **gp3** configurável (modelos ficam no volume)

Os **nomes** dos modelos (chat / embed) vêm das variáveis GitHub; o servidor só precisa ter os pesos (`ollama pull`). O workflow pode sincronizar modelos via SSM após cada deploy.

## Variáveis GitHub (origemlab-services)

| Variável | Obrigatória | Exemplo |
|----------|-------------|---------|
| `OLLAMA_SERVER_STACK_NAME` | não | default `origemlab-ollama` |
| `VPC_ID` | sim | mesma VPC dos tasks ECS |
| `OLLAMA_SERVER_SUBNET_ID` | não | se vazio, usa a 1ª entrada de `SUBNET_IDS` |
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

## SSH e Ollama na Internet (CloudFormation)

O stack configura:

| Porta | Origem (default) | Uso |
|-------|------------------|-----|
| **11434** | `0.0.0.0/0` (`PublicAccessCidr`) | Ollama (browser, dev local) |
| **22** | `0.0.0.0/0` (`SshAccessCidr`) | SSH |
| **11434** | VPC CIDR | ECS / EB na mesma VPC |

Variáveis GitHub (opcional, restringir em prod):

- `OLLAMA_SERVER_PUBLIC_ACCESS_CIDR` — ex. `seu-ip/32`
- `OLLAMA_SERVER_SSH_ACCESS_CIDR` — ex. `seu-ip/32`
- `OLLAMA_SERVER_KEY_PAIR_NAME` — opcional (default no deploy: **`ia-server-keys`**)

### SSH com key pair existente

1. O key pair **`ia-server-keys`** deve existir na região (EC2 → Key pairs).
2. Opcional no GitHub: `OLLAMA_SERVER_KEY_PAIR_NAME=ia-server-keys` (já é o default do workflow).
3. Redeploy **deploy-ollama-server** (se a instância foi criada sem chave, o update pode **recriar** a EC2 para associar a chave).

**Importante:** `KeyPairName` só aplica no **primeiro launch** da EC2. Se a instância já existe sem chave, o update do stack **abre a porta 22** mas SSH ainda precisa de **nova instância** com chave (ou use **SSM**, sem `.pem`).

```bash
chmod 400 ia-server-keys.pem
ssh -i ia-server-keys.pem ec2-user@<ElasticIP>
```

## Testar se o Ollama responde

O browser em `http://<ElasticIP>:11434/` pode não mostrar HTML; use:

```bash
curl -s http://52.6.141.185:11434/api/tags
```

Se der timeout **do teu PC** mas a EC2 existe: o security group antigo só abria a porta **para a VPC** (`172.31.0.0/16`). Faz redeploy com `PublicAccessCidr=0.0.0.0/0` (default no template) ou define no GitHub `OLLAMA_SERVER_PUBLIC_ACCESS_CIDR=seu-ip/32`.

Na instância (SSM), o bootstrap demora vários minutos (`ollama pull`):

```bash
aws ssm start-session --target <InstanceId>
sudo tail -f /var/log/ollama-userdata.log
curl -s http://127.0.0.1:11434/api/tags
```

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
    "iam:GetRole",
    "iam:ListRoles",
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
    "ssm:DescribeInstanceInformation",
    "ec2:DescribeImages",
    "ec2:CreateTags",
    "ec2:DeleteTags"
  ],
  "Resource": "*"
}
```

## GPU

Use `OLLAMA_SERVER_INSTANCE_TYPE=g5.2xlarge` (ou maior) e, se necessário, `OLLAMA_SERVER_AMI_ID` com uma **Deep Learning AMI** que já traga drivers NVIDIA. O bootstrap usa o script oficial do Ollama em Amazon Linux 2023.
