# Atualização da produção por script no host, sem `docker.sock` no daemon

A produção local é um clone separado do repositório no GitHub, levado a uma tag de release por `scripts/atualizar.sh`, executado pelo humano no host. O script para o daemon, faz backup do `atm.db`, faz checkout da tag, sobe com `docker compose up -d --build --wait` e, se a versão nova não ficar saudável, restaura o backup e volta para a tag anterior. Publicar versão é decisão humana: o humano faz o merge no `main` e cria a tag; agentes só empurram branches (nem `main`, nem tags). O daemon nunca recebe `docker.sock`.

Complementa, sem substituir, o ADR-0001 (o portão de aprovação passa a cobrir também a publicação de versão) e o ADR-0006 (agentes continuam dentro do container do daemon, e por isso o container não pode ter poder sobre o Docker do host).

## Considered Options

- Serviço `updater` no Compose com `docker.sock`: permite atualizar por um botão na UI sem nada instalado no host, mas quem controla o socket é root no host; uma Rodada comprometida (agentes rodam no mesmo Compose, ADR-0006) chegaria lá por um serviço vizinho.
- Daemon com `docker.sock` montado: o caminho mais curto, e o pior: o processo que executa agentes viraria root no host, anulando o isolamento do ADR-0006 e o menor privilégio do ADR-0001.
- Atualização automática ao detectar commit ou tag nova: tira o humano do portão de publicação (ADR-0001) e põe a produção à mercê de `main` instável. Descartada; a produção só muda quando o humano cria uma tag e roda o script.
- Imagens pré-construídas, CI e registry: custo e infraestrutura sem necessidade para uma instância local; o build continua local.

## Consequences

- Rollback = backup, não migração reversa: as migrações do banco só andam para frente. O rollback não recupera dados criados depois da atualização (só ocorre nos primeiros segundos, na janela do `--wait`).
- Rodadas em andamento são interrompidas pela parada do daemon; no próximo boot ficam `interrompida` (não contam como falha) e são retomadas por nova Rodada a partir do último Checkpoint (ADR-0004). Não há modo de drenagem.
- Atualizar exige o terminal do host. Uma etapa 2 (planejada, ainda não implementada) pode adicionar um botão na UI que apenas grava um pedido num diretório compartilhado, disparado por uma unit `systemd --user` instalada pelo humano e rodando o mesmo script; mesmo assim o daemon não ganha `docker.sock`.
- O script recusa rodar sem `origin` ou com árvore suja, para nunca atuar no checkout de desenvolvimento por acidente nem subir código que não é de uma tag.
