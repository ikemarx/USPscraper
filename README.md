# USPscraper

Extensão de navegador para baixar os materiais das suas disciplinas no [edisciplinas.usp.br](https://edisciplinas.usp.br) com um clique.

## O que ela faz

- Lista as disciplinas em que você está matriculado (filtradas por "em andamento" ou todas)
- Baixa arquivos (`mod/resource`), pastas compactadas (`mod/folder`) e resolve links externos (`mod/url`)
- Salva um `index.html` da página do curso com os links já apontando para os arquivos baixados
- Busca a ementa da disciplina no JupiterWeb e salva como `disciplina.html`

Cada disciplina é salva em uma pasta com o nome do curso, dentro da pasta de downloads do navegador:

```
Nome da Disciplina/
├── files/
│   ├── Aula01.pdf
│   ├── Aula02.pdf
│   └── Materiais.zip
├── index.html
└── disciplina.html
```

## Instalação

### Firefox (recomendado)

Disponível na [Firefox Add-ons Store](https://addons.mozilla.org/pt-BR/firefox/addon/uspscraper/).

### Chrome / Edge (modo desenvolvedor)

1. Baixe ou clone este repositório
2. Abra `chrome://extensions` (ou `edge://extensions`)
3. Ative o **Modo desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta do repositório

## Como usar

1. Faça login no [edisciplinas.usp.br](https://edisciplinas.usp.br)
2. Clique no ícone da extensão na barra de ferramentas
3. Selecione as disciplinas desejadas
4. Clique em **Baixar selecionados**

## Permissões necessárias

| Permissão | Motivo |
|---|---|
| `cookies` | Verificar se o usuário está logado no edisciplinas |
| `downloads` | Salvar os arquivos no computador |
| `edisciplinas.usp.br` | Acessar a API do Moodle e buscar os arquivos |
| `uspdigital.usp.br` | Buscar a ementa da disciplina no JupiterWeb |

## Compatibilidade

- Firefox 140+
- Chrome / Edge (Manifest V3)

## Licença

[MIT](LICENSE)
