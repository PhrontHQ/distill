const fs = require("fs")
const uglify = require("uglify-js")
const minify = uglify.minify
const cwd = process.cwd()
const BUILD_DIRECTORY = "node-build"


function _findRequiresInNode(node, base, out, visited) {
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
        _findRequiresInNode(node[propertyName], base, out, visited)
      }
    }
  }
}

function findRequires(ast, base) {
  const out = []
  _findRequiresInNode(ast, base, out, visited = new Set)
  return out
}

function rebase(base, path) {
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

function load(path) {
  return fs.readFileSync(path, "utf8")
}

function moduleIdWithoutExportSymbol(locationId) {
    var bracketIndex = locationId.indexOf("[");

    if (bracketIndex > 0) {
        return locationId.substr(0, bracketIndex);
    } else {
        return locationId;
    }
}

function parseMJSONDependencies(jsonRoot) {
    var rootEntries = Object.keys(jsonRoot),
        i=0, iLabel, dependencies = [], iLabelObject;

    while ((iLabel = rootEntries[i])) {
        iLabelObject = jsonRoot[iLabel];
        if(iLabelObject.hasOwnProperty("prototype")) {
            dependencies.push(moduleIdWithoutExportSymbol(iLabelObject["prototype"]));
            if(dependencies[dependencies.length-1] === "montage/core/meta/object-descriptor-reference") {
                dependencies.push(iLabelObject.properties.valueReference.objectDescriptorModule["%"]);
            }
        }
        else if(iLabelObject.hasOwnProperty("object")) {
            dependencies.push(moduleIdWithoutExportSymbol(iLabelObject["object"]));
        }

        i++;
    }
    return dependencies;
}

function minimizePackageLockJsonNode(node) {
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
      minimizePackageLockJsonNode(node[name])
    }
  }
}

function minimizePackageLockJson(parsed) {
  for (let name of Object.getOwnPropertyNames(parsed.packages)) {
    try {
      require.resolve(cwd + "/" + BUILD_DIRECTORY +  "/" + name)
    } catch (error) {
      delete parsed.packages[name]
    }
  }
  for (let name of Object.getOwnPropertyNames(parsed.dependencies)) {
    if (!fs.existsSync(cwd + "/" + BUILD_DIRECTORY +  "/node_modules/" + name)) {
      delete parsed.dependencies[name]
    }
  }
  minimizePackageLockJsonNode(parsed)
}

async function visitMjson(base, file) {
  const parsed = JSON.parse(file)
  const dependencies = parseMJSONDependencies(parsed)
  await Promise.all(dependencies.map(path => visit(base, path)))
  return JSON.stringify(parsed)
}

const uglifyOptions = {
  warnings: false,
  compress: {
    passes: 2,
    toplevel: true
  },
  mangle: {
    toplevel: true
  }
}
async function visitJs(base, file) {
  const ast = uglify.parse(file)
  const requires = findRequires(ast, base)
  let minified = minify(ast.print_to_string(), uglifyOptions)
  const visits = []
  for (let aRequire of requires) {
    visits.push(visit(base, aRequire))
  }
  await Promise.all(visits)
  return file
  return minified.code
}

const visitedPaths = new Map
async function visit(base, path) {
  process.stdout.write("\rFiles: " + visitedPaths.size)
  if (moduleIdWithoutExportSymbol(path) !== "global") {
    try {
      const absolutePath = rebase(base, path)
      if (!visitedPaths.has(absolutePath)) {
        const file = load(absolutePath)
        visitedPaths.set(absolutePath, {})
        let parsed
        switch (absolutePath.substr(absolutePath.lastIndexOf(".") + 1)) {
        case "mjson":
          output = await visitMjson(absolutePath, file)
          break
        case "js":
          output = await visitJs(absolutePath, file)
          break
        case "json":
          parsed = JSON.parse(file)
          if (path === "package-lock.json") {
            minimizePackageLockJson(parsed)
          }
          output = JSON.stringify(parsed)
          break
        default:
          output = await visitJs(absolutePath, file)
        }
        visitedPaths.get(absolutePath).size = Buffer.byteLength(output, 'utf8')
        const outputPath = BUILD_DIRECTORY + "/" + absolutePath.substr(cwd.length + 1)
        const outputDirectory = outputPath.substr(0, outputPath.lastIndexOf("/"))
        fs.mkdirSync(outputDirectory, { recursive: true })
        fs.writeFileSync(outputPath, output)
        await Promise.all([
          visit(absolutePath, "package.json")
        ])
      }
    } catch (error) {}
  }
}

async function init() {
  console.time("Time")
  try {
    fs.rmSync(BUILD_DIRECTORY, { recursive: true })
  } catch (error) {}
  const appPackage = JSON.parse(load(rebase(cwd, "package.json")))
  const include = appPackage.include ?? [appPackage.main]
  await Promise.all(include.map(entryPoint => visit(cwd, entryPoint)))
  visit(cwd, "package-lock.json")
  console.log("\nSize: " + [...visitedPaths].reduce((p, [,c]) => p + c.size, 0))
  console.timeEnd("Time")
}

init()
