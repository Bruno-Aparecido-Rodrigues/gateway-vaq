# Imagem JVM (mesma construção do Dockerfile_JVM do professor), em duas etapas.
# O gateway não tem módulo domain: é um projeto Maven só.
FROM maven:3.9-amazoncorretto-17 AS build
WORKDIR /build

COPY pom.xml .
COPY src src

RUN mvn clean package -DskipTests

FROM amazoncorretto:17-alpine
LABEL MANTAINER="FATEC"
WORKDIR /app
EXPOSE 8080
COPY --from=build /build/target/*.jar app.jar
# O plano gratuito do Render tem 512 MB: limita o heap para o container não ser derrubado
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=60", "-XX:+UseSerialGC", "-jar", "app.jar"]
