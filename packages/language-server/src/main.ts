#!/usr/bin/env node
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startServer } from "./server.js";

startServer(createConnection(ProposedFeatures.all));
