import * as fs from 'fs';
import { execSync } from "child_process";

import { program } from "commander";
import * as csv from "fast-csv";
import { Octokit, App } from "octokit";
import { request } from "@octokit/request";
import { createAppAuth } from "@octokit/auth-app";

// cli options
program
  .name("mirror.js")
  .description("mirror to github enterprise from github.com and bitbucket")
  .option("-s, --source <source>", "source repo")
  .option("-m, --mirror <mirror>", "mirror repo")
  .option("-c, --csv <csv>", "csv file")
  .option("-b, --bitbucket", "uses bitbucket to source repos")
  .option("-l, --gitlab", "uses gitlab to source repos")

program.parse();
const opts = program.opts();

// initialize octokit using github app
function octokit_constructor(url, app_id, private_key, installation_id) {
  return new Octokit({
    baseUrl: url,
    authStrategy: createAppAuth,
    auth: {
      appId: app_id,
      privateKey: private_key,
      installationId: installation_id,
    }
  });
}

// format the github url (GHES supported)
function url_format(url) {
  if (url == "https://api.github.com") {
    return "github.com"
  }
  else {
    return (new URL(url)).host;
  }
}

function https_basic_auth(repo, url, token) {
  execSync(
    `git clone --bare https://${token}@${url}/${repo}.git source`,
    { stdio: "ignore" }
  );
}

function bitbucket_clone(repo) {
  let url = process.env.BITBUCKET_HOST 
  let token = process.env.BITBUCKET_APP_CREDENTIALS;
  https_basic_auth(repo, url, token);
}

function gitlab_clone(repo) {
  let url = process.env.GITLAB_HOST 
  let token = process.env.GITLAB_APP_CREDENTIALS;
  https_basic_auth(repo, url, token);
}

function github_clone(repo, token) {
  let url = url_format(process.env.SOURCE_API_URL);
  execSync(
    `git clone --bare https://x-access-token:${token}@${url}/${repo} source`,
    { stdio: "ignore" }
  );
}

function github_push(repo, token) {
  let url = url_format(process.env.MIRROR_API_URL);
  execSync(
    "git -C source/ push --mirror " + 
    `https://x-access-token:${token}@${url}/${repo}`,
    { stdio: "ignore" }
  );
}

// return the auth token for the app
async function github_token(inst) {
  return await inst.auth({
    type: "installation"
  }).then((auth) => auth.token);
}

// check to see if the mirror repo exists
async function github_repo_check(mirror, token) {
  const [org, repo] = mirror.split("/");
  return await mirror_inst.request("GET /repos/{owner}/{repo}", {
    headers: {
      authorization: `token ${token}`,
    },
    owner: org,
    repo: repo,
  }).then((resp) => {
    if(resp.status == 200 ) {
      console.log("# mirror repo already exists on " +
        url_format(process.env.MIRROR_API_URL));
      return true
    }
  }).catch((err) => {
    console.log("# mirror repo does not exist");
    return false;
  });
}

// create mirror repo
async function github_repo_create(mirror, token) {
  const [org, repo] = mirror.split("/");
  return await mirror_inst.request("POST /orgs/{org}/repos", {
    headers: {
      authorization: `token ${token}`,
    },
    org: org,
    name: repo,
    private: false,
    visibility: "internal"
  }).then((resp) => {
    if(resp.status == 201) {
      console.log("# mirror repo created");
    }
    else {
      console.log("# mirror repo creation failed");
    }
  });
}

function read_csv(csv_file) {
  let repos = []
  fs.createReadStream(csv_file)
  .pipe(csv.parse({ headers: true }))
  .on("error", error => console.error(error))
  .on("data", row => {
    repos.push(row);
  })
  .on("end", data => {
    (async function() {
      for (const repo of repos) {
        await main(repo.source, repo.mirror);
      }
    })();
  });
}

async function main(source_repo, mirror_repo) {
  execSync("rm -rf source/");
  console.log("\n# migration - starting");
  console.log(`# mirroring ${source_repo} => ${mirror_repo}`);
  console.log(`# cloning ${source_repo}`);
  if (opts.bitbucket) {
    bitbucket_clone(source_repo);
  }
  else if (opts.gitlab) {
    gitlab_clone(source_repo);
  }
  else {
    github_clone(source_repo, source);
  }
  console.log(`# cloning ${source_repo} - done`);
  const check = await github_repo_check(mirror_repo, mirror);
  if(!check) {
    console.log(`# creating ${mirror_repo} repo`);
    await github_repo_create(mirror_repo, mirror);
    console.log(`# creating ${mirror_repo} repo - done`);
  }
  console.log(`# pushing ${mirror_repo}`);
  github_push(mirror_repo, mirror);
  console.log(`# pushing ${mirror_repo} - done`);
  execSync("rm -rf source/");
  console.log("# source repo removed");
  console.log("# migration - completed");
}

// construct octokit instances for each github app (source, mirror)
const source_inst = octokit_constructor(
  process.env.SOURCE_API_URL,
  process.env.SOURCE_APP_ID,
  process.env.SOURCE_PEM,
  process.env.SOURCE_INSTALLATION_ID
);

const mirror_inst = octokit_constructor(
  process.env.MIRROR_API_URL,
  process.env.MIRROR_APP_ID,
  process.env.MIRROR_PEM,
  process.env.MIRROR_INSTALLATION_ID
);

// get the auth tokens
const source = await github_token(source_inst);
const mirror = await github_token(mirror_inst);

// announce the start of the migration
if (opts.bitbucket) {
  console.log("# using bitbucket to source repos");
}
else if (opts.gitlab) {
  console.log("# using gitlab to source repos");
}
else {
  console.log("# using github to source repos");
}

// prevent users from running it without the required options
if (opts.source && opts.mirror) {
  main(opts.source, opts.mirror);
}
else if (opts.csv) {
  read_csv(opts.csv);
}
else if (opts.source && opts.csv) {
  console.log("# source and csv cannot be used together");
}
else if (opts.mirror && opts.csv) {
  console.log("# mirror and csv cannot be used together");
}
else if (opts.source && !opts.mirror) {
  console.log("# missing mirror repo");
}
else if (!opts.source && opts.mirror) {
  console.log("# missing source repo");
}
else if (!opts.source && !opts.mirror && !opts.csv) {
  console.log("# missing required arguments. " +
    "You need to specify a source repo, mirror repo, or csv file");
}
