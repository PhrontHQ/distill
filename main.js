'use strict';

/*
  Looked at this example:
  https://github.com/floydspace/serverless-esbuild/blob/09f08c738171ed7e7b50727bef1846e9b0bcf579/src/pack.ts#L90
*/
const fs = require("fs")
const uglify = require("uglify-js")
const minify = uglify.minify
const cwd = process.cwd()
const BUILD_DIRECTORY = ".serverless/"

const path = require('path');

const semver = require('semver');
const micromatch = require('micromatch');

const getDependencyList = require('./get-dependency-list');

const zip = require("zip-a-folder").zip;
const { throws } = require("assert");

function union(a = [], b = []) {
  const existing = [].concat(a);
  const set = new Set(existing);

  [].concat(b).forEach(p => {
    if (set.has(p)) {
      return;
    }
    set.add(p);
    existing.push(p);
  });

  return existing;
}


const uglifyOptions = {
  warnings: false,
  compress: {
    passes: 2,
    toplevel: true
  },
  mangle: {
    toplevel: false
  },
  v8: true
}

/* mild one that ends up readable */
// const uglifyOptions = {
//   warnings: false,
//   compress: {
//     passes: 2,
//     toplevel: true
//   },
//   output: {
//     beautify: true,
//     comments: false,
//   },
//   mangle: true,
//   v8: true
// }

const visitedPaths = new Map


module.exports = class IncludeDependencies {

  constructor(serverless, options) {
    if (!semver.satisfies(serverless.version, '>= 2.32')) {
      throw new Error('serverless-plugin-include-dependencies requires serverless 2.32 or higher!');
    }

    this.serverless = serverless;
    this.options = options;
    this.cache = new Set();
    this.processedFileNames = new Set;

    const service = this.serverless.service;
    this.individually = service.package && service.package.individually;
    this.minify = service.package && service.package.minify;
    this.include = service.custom.distill.include;
    this.minifyPatterns = service.custom.distill.minifyPatterns;
    this.absoluteProjectPathPrefix = cwd+"/";

    this.buildDirectory = BUILD_DIRECTORY + path.basename(cwd);


    var matcherOptions = this._matcherOptions = {
      cwd: cwd,
      basename: false
    };

    var minifyExclusionMatchers,
        minifyInclusionMatchers;

    this.minifyPatterns.map(p => {
        if(p.startsWith("!")) {
          (minifyExclusionMatchers || (minifyExclusionMatchers = [])).push(micromatch.matcher(p, matcherOptions));
        } else {
          (minifyInclusionMatchers || (minifyInclusionMatchers = [])).push(micromatch.matcher(p, matcherOptions));
        }
    });

    this.minifyExclusionMatchers = minifyExclusionMatchers;
    this.minifyInclusionMatchers = minifyInclusionMatchers;


    this.hooks = {
      'before:deploy:function:packageFunction': this.functionDeploy.bind(this),
      'before:package:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this)
    };
  }

  functionDeploy() {
    return this.processFunction(this.options.function);
  }

  async createDeploymentArtifacts() {
    console.time("createDeploymentArtifacts");

    try {
      fs.rmSync(this.buildDirectory, { recursive: true })
    } catch (error) {}
  
    const { service = {} } = this.serverless;
    const { functions = {} } = service;
    const promises = [];


    for (const functionName in functions) {
      let iPromise = this.processFunction(functionName);
      if(iPromise) {
        promises.push(iPromise);
      }
    }

    return Promise.all(promises)
      .then(() => {
        var zippedPath = path.join(cwd,`.serverless/${this.serverless.service.service}.zip`);

        //Should we worry about serverless not existing at this point?
        //fs.mkdirSync(outputDirectory, { recursive: true })
    
        return zip(path.join(cwd,this.buildDirectory), zippedPath)
        .then(() => {
          this.serverless.service.package.artifact = zippedPath;
          console.timeEnd("createDeploymentArtifacts");  
        })
      })

  }

  async processFunction(functionName) {
    console.log("processFunction("+functionName+")");
    const { service = {} } = this.serverless;

    service.package = service.package || {};
    service.package.patterns = union(['!node_modules/**'], service.package.patterns);

    const functionObject = service.functions[functionName];
    const runtime = this.getFunctionRuntime(functionObject);

    if (/(provided|nodejs)+/.test(runtime)) {
      return this.processNodeFunction(functionObject);
    }
  }

  getPluginOptions() {
    const service = this.serverless.service;
    return (service.custom && service.custom.includeDependencies) || {};
  }



  preparePackageArtifact() {
      // 1) If individually is not set, just zip the all build dir and return
    if (!this.serverless?.service?.package?.individually) {
      const zipName = `${this.serverless.service.service}.zip`;
      const artifactPath = path.join(this.workDirPath, SERVERLESS_FOLDER, zipName);

      // // remove prefixes from individual extra files
      // const filesPathList = pipe<IFiles, IFiles, IFiles>(
      //   reject(test(/^__only_[^/]+$/)) as (x: IFiles) => IFiles,
      //   map(over(lensProp('localPath'), replace(/^__only_[^/]+\//, '')))
      // )(files);

      // const startZip = Date.now();
      // await zip(artifactPath, filesPathList, this.buildOptions.nativeZip);
      // const { size } = fs.statSync(artifactPath);

      // this.serverless.cli.log(
      //   `Zip service ${this.serverless.service.service} - ${humanSize(size)} [${
      //     Date.now() - startZip
      //   } ms]`
      // );
      // defined present zip as output artifact
      this.serverless.service.package.artifact = artifactPath;
      return;
    } else {
      throw "preparePackageArtifact not implemented for package individually setting"
    }

  }

  _findRequiresInNode(node, base, out, visited) {
    visited.add(node)
    if (
      node instanceof uglify.AST_Call &&
      node.expression &&
      (
        node.expression.name === "require" ||
        (
          node.expression instanceof uglify.AST_Dot &&
          node.expression.property === "async"
        )
      ) &&
      node.args &&
      node.args.length === 1 &&
      node.args[0] instanceof uglify.AST_String
      ) {
      out.push(node.args[0].value)
      /*try {
        if (node.args[0].value.indexOf("/") !== -1)
          node.args[0].value = rebase(base, node.args[0].value).replace(/plumming-data-worker/g, "plumming-data-worker/node-build")
      } catch (error) {}*/
    }
    if (typeof node === "object") {
      for (let propertyName of Object.getOwnPropertyNames(node)) {
        if (node[propertyName] && typeof node[propertyName] === "object" && !visited.has(node[propertyName])) {
          this._findRequiresInNode(node[propertyName], base, out, visited)
        }
      }
    }
  }

  findRequires(ast, base) {
    const out = []
    const visited = new Set
    this._findRequiresInNode(ast, base, out, visited)
    return out
  }

  rebase(base, path) {
    let packageRoot = base
    try {
      if (path.startsWith(".")) {
        return require.resolve(path, {paths: [base.substr(0, base.lastIndexOf("/"))]})
      }
      while (!fs.existsSync(packageRoot + "/package.json")) {
        packageRoot = packageRoot.substr(0, packageRoot.lastIndexOf("/"))
      }
      return require.resolve(path + "/", {paths: [packageRoot]})
    } catch (error) {
      try {
        return require.resolve(path, {paths: [packageRoot]})
      } catch (error) {
        try {
          return require.resolve(packageRoot + "/" + path)
        } catch (error) {
          if (path !== "package-lock.json") {
            console.warn("\rMissing", path, "@", base)
          }
          throw error
        }
      }
    }
  }

  load(path) {
    return fs.readFileSync(path, "utf8")
  }

  moduleIdWithoutExportSymbol(locationId) {
    var bracketIndex = locationId.indexOf("[");

    if (bracketIndex > 0) {
        return locationId.substr(0, bracketIndex);
    } else {
        return locationId;
    }
  }

  parseMJSONDependencies(jsonRoot, base) {
    var rootEntries = Object.keys(jsonRoot),
        i=0, iLabel, dependencies = [], iLabelObject,
        values, valuesKeys, j, countJ, jModule, jKeyValue;

    while ((iLabel = rootEntries[i])) {
        iLabelObject = jsonRoot[iLabel];
        if(iLabelObject.hasOwnProperty("prototype")) {
            dependencies.push(this.moduleIdWithoutExportSymbol(iLabelObject["prototype"]));
            if(dependencies[dependencies.length-1] === "montage/core/meta/object-descriptor-reference") {
                dependencies.push(iLabelObject.properties.valueReference.objectDescriptorModule["%"]);
            }
        }
        else if(iLabelObject.hasOwnProperty("object")) {
            dependencies.push(this.moduleIdWithoutExportSymbol(iLabelObject["object"]));
        }

        //Check for modules.
        
        values = iLabelObject.values || iLabelObject.properties;
        valuesKeys = values ? Object.keys(values) : null;

        if(valuesKeys) {
          for(j=0, countJ = valuesKeys.length, jModule, jKeyValue; (j < countJ); j++) {
            if(typeof (jKeyValue = values[valuesKeys[j]]) === "object" && jKeyValue && jKeyValue.hasOwnProperty("%")) {
              jModule = this.moduleIdWithoutExportSymbol(jKeyValue["%"]);
              /*
                We need to eliminate cases where the module refers to the current file,
                like the objectDescriptorModule property in serialized "montage/core/meta/module-object-descriptor"

                This is not perfect but will do for now.
              */
             if(!(jModule.startsWith("./") && (base.endsWith(jModule.substring(1))))) {
              //console.debug("Adding dependency "+jModule);
                dependencies.push(jModule);
             }
            }

          }
        }

        i++;
    }
    return dependencies;
  }

  minimizePackageLockJsonNode(node) {
    if (typeof node === "object") {
      delete node.version
      delete node.license
      delete node.integrity
      delete node.resolved
      delete node.lockfileVersion
      delete node.engines
      delete node.dev
      delete node.devDependencies
      for (let name of Object.getOwnPropertyNames(node)) {
        this.minimizePackageLockJsonNode(node[name])
      }
    }
  }

  minimizePackageLockJson(parsed) {
    for (let name of Object.getOwnPropertyNames(parsed.packages)) {
      try {
        if(!fs.existsSync(`${cwd}/${this.buildDirectory}/${name}`)) {
            delete parsed.packages[name]
        }
      } catch (error) {
        console.error(error);
      }
    }

    delete parsed.dependencies;

    this.minimizePackageLockJsonNode(parsed)
  }

  async visitMjson(base, file) {
    const parsed = JSON.parse(file)
    const dependencies = this.parseMJSONDependencies(parsed, base)
    await Promise.all(dependencies.map(path => this.visitFile(base, path)))
    //Removes white spaces
    return JSON.stringify(parsed)
  }

  shouldMinifyFileAtProjectRelativePath(filePath) {
    var relativePath = filePath.split(this.absoluteProjectPathPrefix)[1];
      const minifyExclusionMatchers = this.minifyExclusionMatchers;
  
      // const isExclusionMatch = micromatch.isMatch(filePath,this.minifyPatterns,this._matcherOptions);
      // const isInclusionMatch = micromatch.isMatch(filePath,this.minifyPatterns,this._matcherOptions);

      // console.log("shouldMinifyFileAtProjectRelativePath " +filePath+ ": isExclusionMatch is "+isExclusionMatch+", isInclusionMatch is "+isInclusionMatch);

      // return !isExclusionMatch || isInclusionMatch;

      var shouldExclude = false
      for(let i = 0, iExclusionMatcher;(iExclusionMatcher = minifyExclusionMatchers[i]); i++) {
        if(!iExclusionMatcher(relativePath)) {
          // console.log("shouldMinifyFileAtPath (iExclusionMatcher) is "+false);
          shouldExclude = true;
          break;
        }
      }

      var shouldInclude = false
      const minifyInclusionMatchers = this.minifyInclusionMatchers;
      for(let i = 0, iInclusionMatcher;(iInclusionMatcher = minifyInclusionMatchers[i]); i++) {
        if(iInclusionMatcher(relativePath)) {
          // console.log("shouldMinifyFileAtPath (iInclusionMatcher) is "+false);
          shouldInclude = true;
          break;
        }
      }

      //var shouldMinifyFileAtProjectRelativePath = !shouldExclude || shouldInclude;
      var shouldMinifyFileAtProjectRelativePath = shouldInclude && !shouldExclude;

      //console.log("shouldMinifyFileAtProjectRelativePath "+ relativePath +" is " + shouldMinifyFileAtProjectRelativePath);
      return shouldMinifyFileAtProjectRelativePath;
  }
  
  async visitJs(absolutePath, file) {
    try {
      const basename = path.basename(absolutePath)
      const isJavascriptFile = (path.extname(basename) === ".js")

      if(isJavascriptFile) {
        // console.log("shouldMinifyFileAtPath "+absolutePath+" is true");
        const ast = uglify.parse(file)
        const requires = this.findRequires(ast, absolutePath)
        const visits = []
        
        for (let aRequire of requires) {
          visits.push(this.visitFile(absolutePath, aRequire))
        }
        await Promise.all(visits)

        /*
            uglifyjs app.js \
              -o app.min.js.map \
              --source-map url=app.min.js.map,includeSources
        */

          const _uglifyOptions = {};
          Object.assign(_uglifyOptions, uglifyOptions)

          // _uglifyOptions.sourceMap = {
          //     filename: basename,
          //     url: `${basename}.map`
          // };

          return (this.shouldMinifyFileAtProjectRelativePath(absolutePath)) 
          //? minify(ast.print_to_string(), _uglifyOptions)
          ? minify(file, _uglifyOptions)
          : file

      } else {
        return file;
      }

    } catch(error) {
      return file
    }
  }

  async visit(base, aPath) {
    const absolutePath = path.join(base, aPath);
    if(fs.statSync(absolutePath).isDirectory()) {
      return this.visitDirectory(base, aPath);
    } else {
      return this.visitFile(base, aPath);
    }
  }

  async visitDirectory(base, aPath) {
      const absolutePath = path.join(base, aPath);
      const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  
      // Get files within the current directory and add a path key to the file objects
      const filePromises = entries
          .filter(file => !file.isDirectory())
          //.map(file => ({ ...file, path: path + file.name }));
          .map(file => { 
            return this.visitFile(base, `${aPath}/${file.name}`)
          });
    
      // Get folders within the current directory
      const folders = entries.filter(folder => folder.isDirectory());
  
      for (const folder of folders)
          /*
            Add the found files within the subdirectory to the files array by calling the
            current function itself
          */
            filePromises.push(...await this.visitDirectory(base,`${aPath}/${folder.name}`));
  
      return Promise.all(filePromises);
  
  }

  async visitFile(base, path) {
    //process.stdout.write("\rFiles: " + visitedPaths.size)
    if (this.moduleIdWithoutExportSymbol(path) !== "global") {
      try {
        const absolutePath = this.rebase(base, path)
        var output
        if (!visitedPaths.has(absolutePath)) {
          const file = this.load(absolutePath)
          visitedPaths.set(absolutePath, {})
          let parsed
          switch (absolutePath.substr(absolutePath.lastIndexOf(".") + 1)) {
          case "mjson":
            output = await this.visitMjson(absolutePath, file)
            break
          case "js":
            output = await this.visitJs(absolutePath, file)
            break
          case "json":
            parsed = JSON.parse(file)
            if (path === "package-lock.json") {
              this.minimizePackageLockJson(parsed)
            }
            //Removes white spaces
            output = JSON.stringify(parsed)
            break
          default:
            output = await this.visitJs(absolutePath, file)
          }

          const outputPath = this.buildDirectory + "/" + absolutePath.substr(cwd.length + 1)
          const outputDirectory = outputPath.substr(0, outputPath.lastIndexOf("/"))
          fs.mkdirSync(outputDirectory, { recursive: true })

          if(typeof output === "object") {
            if(output.map) {
              fs.writeFileSync(`${outputPath}.map`, output.map)
            }
            output = output.code
          }

          visitedPaths.get(absolutePath).size = Buffer.byteLength(output, 'utf8')
          fs.writeFileSync(outputPath, output)

          await Promise.all([
            this.visitFile(absolutePath, "package.json")
          ])
        }
      } catch (error) {}
    }
  }
  
  async processNodeFunction(functionObject) {
    console.time("processNodeFunction")

    const { service } = this.serverless;

    functionObject.package = functionObject.package || {};
    
    const fileName = this.getHandlerFilename(functionObject.handler);
    const fileBasename = path.basename(fileName);

    if(!this.processedFileNames.has(fileName)) {
      this.processedFileNames.add(fileName);

      const appPackage = this.getProjectPackage();
      const include = appPackage.include ?? [fileBasename]

      /*
        Make sure the file for the current function is included
      */
      if(include.indexOf(fileBasename) === -1) {
        include.unshift(fileBasename)
      }

      if(this.include) {
        include.push.apply(include,this.include);
      }

      return Promise.all(include.map(entryPoint => this.visit(this.serverless.serviceDir, entryPoint))).then(() => {
        var result = this.visitFile(cwd, "package-lock.json");
        console.log("\nSize: " + [...visitedPaths].reduce((p, [,c]) => p + c.size, 0))
        console.timeEnd("processNodeFunction");  
        return result;
;
      })
    }
    // const dependencies = this.getDependencies(fileName, service.package.patterns);

    // const target = this.individually ? functionObject : service;
    // target.package.patterns = union(target.package.patterns, dependencies);
  }

  getFunctionRuntime(functionObject) {
    const { service } = this.serverless;

    const functionRuntime = functionObject.runtime;
    const providerRuntime = service.provider && service.provider.runtime;

    return functionRuntime || providerRuntime;
  }

  getHandlerFilename(handler) {
    const lastDotIndex = handler.lastIndexOf('.');
    const handlerPath = lastDotIndex !== -1 ? handler.slice(0, lastDotIndex) : 'index';
    return require.resolve((path.join(this.serverless.config.servicePath, handlerPath)));
  }

  getProjectPackage() {
    return this._projectPackage || (this._projectPackage = JSON.parse(this.load(this.rebase(this.serverless.serviceDir, "package.json"))) );
  }

  getDependencies(fileName, patterns) {
    const servicePath = this.serverless.config.servicePath;
    const dependencies = this.getDependencyList(fileName);
    const relativeDependencies = dependencies.map(p => path.relative(servicePath, p));

    const exclusions = patterns.filter(p => {
      return !(p.indexOf('!node_modules') !== 0 || p === '!node_modules' || p === '!node_modules/**');
    });

    if (exclusions.length > 0) {
      return micromatch(relativeDependencies, exclusions);
    }

    return relativeDependencies;
  }

  getDependencyList(fileName) {
    if (!this.individually) {
      const options = this.getPluginOptions();
      if (options && options.enableCaching) {
        return getDependencyList(fileName, this.serverless, this.cache);
      }
    }
    return getDependencyList(fileName, this.serverless);
  }
};
